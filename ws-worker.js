const Lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const EVENT_TYPES = (process.env.LARK_EVENT_TYPES || 'approval.approval.updated_v4')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 LARK_APP_ID / LARK_APP_SECRET，无法启动长连接。');
  process.exit(1);
}

const baseConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
};

const client = new Lark.Client(baseConfig);

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});

const handlers = {};
const seenEventIds = new Set();
const chatContext = new Map();

function seenRecently(eventId) {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  setTimeout(() => seenEventIds.delete(eventId), 10 * 60 * 1000);
  return false;
}

for (const eventType of EVENT_TYPES) {
  handlers[eventType] = async (data) => {
    if (seenRecently(data?.event_id)) {
      return { ok: true };
    }

    console.log(`[WS EVENT] ${eventType}`);
    console.log(JSON.stringify(data));

    // 先快速回执，AI 逻辑异步执行，避免飞书超时重推。
    queueMicrotask(async () => {
      if (eventType === 'im.message.receive_v1') {
        await handleMessageEvent(data);
        return;
      }

      const suggestion = await getAiSuggestion(
        `你是审批助手。请基于以下事件给出：建议结论、风险点、建议操作。事件：${JSON.stringify(data)}`
      );
      console.log('[AI SUGGESTION]', suggestion);
    });

    return { ok: true };
  };
}

async function handleMessageEvent(data) {
  const chatId = data?.message?.chat_id;
  const rawContent = data?.message?.content || '{}';
  const msgType = data?.message?.message_type;

  if (!chatId) {
    return;
  }

  if (msgType === 'interactive') {
    const card = parseJsonSafe(rawContent);
    const cardUrl = card?.card_link?.url || card?.card_link?.pc_url || '';
    const instanceId = extractInstanceId(cardUrl);
    if (instanceId) {
      const prev = chatContext.get(chatId) || {};
      chatContext.set(chatId, { ...prev, instanceId, card });
      await sendText(chatId, '已收到审批卡片。请发送“审核”或“审核 + 你的规则”，我会按审批详情自动分析。');
    }
    return;
  }

  if (msgType !== 'text') {
    return;
  }

  const text = extractText(rawContent);
  if (!text) return;

  if (!text.includes('审核') && !text.includes('审批')) {
    return;
  }

  const ctx = chatContext.get(chatId) || {};
  let sourceText = text;

  if (ctx.instanceId) {
    const detail = await fetchApprovalDetail(ctx.instanceId);
    if (detail.ok) {
      sourceText = `${text}\n\n[审批详情]\n${detail.content}`;
    } else {
      await sendText(chatId, `已识别到审批卡片，但读取详情失败：${detail.error}\n请确认应用已开通审批读取权限。`);
    }
  }

  const ruleProfile = getRuleProfile(text);
  const result = await reviewApprovalText(sourceText, ruleProfile);
  await sendText(chatId, result);
}

function extractText(content) {
  const parsed = parseJsonSafe(content);
  return (parsed?.text || '').trim();
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function extractInstanceId(url) {
  if (!url || typeof url !== 'string') return '';

  // 1) 直接 query: ...?instanceId=123
  let m = url.match(/[?&]instanceId=(\d+)/i);
  if (m?.[1]) return m[1];

  // 2) 审批卡常见场景：instanceId 被 URL 编码在 path 参数里
  // 例如: path=...%3FinstanceId%3D123%26...
  let decoded = url;
  for (let i = 0; i < 3; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }

    m = decoded.match(/instanceId=(\d+)/i);
    if (m?.[1]) return m[1];
  }

  return '';
}

function getRuleProfile(text) {
  const upper = text.toUpperCase();
  if (upper.includes('AP2-3')) {
    return readRuleFile('ap2-3.json');
  }
  return readRuleFile('ap2-3.json');
}

function readRuleFile(name) {
  const filePath = path.join(__dirname, 'rules', name);
  if (!fs.existsSync(filePath)) {
    return '{}';
  }
  return fs.readFileSync(filePath, 'utf8');
}

async function reviewApprovalText(text, ruleProfile) {
  const prompt = `
你是企业审批助手。用户把审批内容转发给你，你必须按规则先检查再给结论。

输出必须包含：
1) 建议结论（建议通过/建议拒绝/建议人工复核）
2) 风险分（0-100）
3) 命中规则
4) 核心理由
5) 需补充材料
6) 建议在审批意见里填写的话术

规则配置：
${ruleProfile}

用户转发文本：
${text}
`;

  return getAiSuggestion(prompt);
}

async function sendText(chatId, text) {
  const safeText = (text || '未生成结果').slice(0, 3000);
  try {
    await client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: safeText }),
      },
    });
  } catch (err) {
    console.error('[SEND MESSAGE ERROR]', err.message);
  }
}

async function fetchApprovalDetail(instanceId) {
  try {
    const res = await client.approval.v4.instance.get({
      path: {
        instance_id: instanceId,
      },
      params: {
        locale: 'zh-CN',
      },
    });

    if (res.code !== 0 || !res.data) {
      return { ok: false, error: `${res.msg || '审批接口返回异常'} (code=${res.code})` };
    }

    const d = res.data;
    const content = [
      `审批名称: ${d.approval_name || ''}`,
      `编号: ${d.serial_number || ''}`,
      `状态: ${d.status || ''}`,
      `申请人(open_id): ${d.open_id || ''}`,
      `表单: ${d.form || ''}`,
    ].join('\n');

    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register(handlers),
});

async function getAiSuggestion(text) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey || !baseUrl) {
    return 'AI_API_KEY / AI_BASE_URL 未配置，先跳过。';
  }

  try {
    const resp = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: [{ role: 'user', content: text }],
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    return resp.data?.choices?.[0]?.message?.content || 'AI 无返回内容';
  } catch (err) {
    return `AI 调用失败: ${err.message}`;
  }
}

process.on('SIGINT', () => {
  console.log('收到 SIGINT，关闭长连接...');
  wsClient.close();
  process.exit(0);
});
