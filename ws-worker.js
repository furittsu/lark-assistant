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
const PENDING_TTL_MS = 30 * 1000;

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
    const cardTitle = (card?.title || '').trim();
    const mentions = data?.message?.mentions || [];
    const mentionedOpenId = mentions?.[0]?.id?.open_id || '';

    const prev = chatContext.get(chatId) || {};
    chatContext.set(chatId, {
      ...prev,
      instanceId,
      cardTitle,
      mentionedOpenId,
      cardRaw: rawContent,
      card,
    });

    if (instanceId) {
      // 乱序容错：若先收到了“审核”文本，再收到卡片，则自动继续审核。
      if (prev.pendingReviewText && Date.now() - prev.pendingAt < PENDING_TTL_MS) {
        const detail = await fetchApprovalDetailSmart(chatId, prev.pendingReviewText);
        let sourceText = '';
        if (!detail.ok) {
          sourceText = `${prev.pendingReviewText}\n\n[卡片内容]\n${extractCardText(chatContext.get(chatId)?.cardRaw || '')}`;
        } else {
          sourceText = `${prev.pendingReviewText}\n\n[审批详情]\n${detail.content}`;
        }
        const ruleProfile = getRuleProfile(prev.pendingReviewText);
        const result = await reviewApprovalText(sourceText, ruleProfile);
        await sendText(chatId, result);

        const latest = chatContext.get(chatId) || {};
        delete latest.pendingReviewText;
        delete latest.pendingAt;
        chatContext.set(chatId, latest);
      } else {
        await sendText(chatId, '已收到审批卡片。请发送“审核”或“审核 编号:202603020071”，我会自动分析。');
      }
    }
    return;
  }

  if (msgType !== 'text') {
    return;
  }

  const text = extractText(rawContent);
  if (!text) return;

  const serialNo = extractSerialNo(text);
  if (serialNo) {
    const prev = chatContext.get(chatId) || {};
    chatContext.set(chatId, {
      ...prev,
      serialNo,
    });
  }

  if (!text.includes('审核') && !text.includes('审批')) {
    return;
  }

  const ctx = chatContext.get(chatId) || {};
  let sourceText = text;

  if (!ctx.instanceId && !ctx.serialNo && !serialNo) {
    chatContext.set(chatId, {
      ...ctx,
      pendingReviewText: text,
      pendingAt: Date.now(),
    });
    await sendText(chatId, '我先记下你的“审核”请求。请转发审批卡片，或直接发“审核 编号:202603020071”。');
    return;
  }

  const detail = await fetchApprovalDetailSmart(chatId, text);
  if (detail.ok) {
    sourceText = `${text}\n\n[审批详情]\n${detail.content}`;
  } else {
    const ctx2 = chatContext.get(chatId) || {};
    const cardText = extractCardText(ctx2.cardRaw || '');
    if (!cardText) {
      await sendText(chatId, `读取审批详情失败：${detail.error}`);
      return;
    }
    sourceText = `${text}\n\n[卡片内容]\n${cardText}`;
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

function extractSerialNo(text) {
  if (!text || typeof text !== 'string') return '';
  const m = text.match(/(?:编号|流水号|serial)\s*[:：]?\s*([0-9]{8,})/i);
  if (m?.[1]) return m[1];
  const m2 = text.match(/\b([0-9]{12})\b/);
  return m2?.[1] || '';
}

function extractCardText(rawContent) {
  const card = parseJsonSafe(rawContent);
  if (!card || typeof card !== 'object') return '';
  const parts = [];
  if (card.title) parts.push(`标题: ${card.title}`);
  const elements = Array.isArray(card.elements) ? card.elements : [];
  for (const el of elements) {
    if (el?.text?.content) parts.push(el.text.content);
    if (Array.isArray(el?.fields)) {
      for (const f of el.fields) {
        if (f?.text?.content) parts.push(f.text.content);
      }
    }
  }
  return parts.join('\n').trim();
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

async function fetchApprovalDetailSmart(chatId, text) {
  const ctx = chatContext.get(chatId) || {};
  const serialNo = extractSerialNo(text) || ctx.serialNo || '';

  // 1) 先尝试把卡片 instanceId 当作 instance_code 调 get（某些场景可直接用）
  if (ctx.instanceId) {
    const direct = await fetchApprovalDetailByCode(ctx.instanceId);
    if (direct.ok) return direct;
  }

  // 2) 用 query 查实例列表，再定位 instance.code
  const queryRes = await queryApprovalInstances({
    serialNo,
    instanceTitle: ctx.cardTitle || '',
    applicantOpenId: ctx.mentionedOpenId || '',
  });

  if (!queryRes.ok) return queryRes;

  const matched = pickBestInstance(queryRes.list, {
    serialNo,
    instanceTitle: ctx.cardTitle || '',
  });

  if (!matched?.instance?.code) {
    return { ok: false, error: '未匹配到审批实例，请补充“审核 编号:xxxx”或重新转发卡片。' };
  }

  const instanceCode = matched.instance.code;
  const update = chatContext.get(chatId) || {};
  update.instanceCode = instanceCode;
  chatContext.set(chatId, update);

  return fetchApprovalDetailByCode(instanceCode);
}

async function queryApprovalInstances({ serialNo, instanceTitle, applicantOpenId }) {
  try {
    if (serialNo) {
      // 先按编号多路尝试，避免无条件查询被拒绝。
      const quickChecks = [
        { instance_code: serialNo },
        { instance_external_id: serialNo },
      ];

      for (const criteria of quickChecks) {
        try {
          const res = await client.approval.v4.instance.query({
            data: {
              ...criteria,
              instance_status: 'ALL',
              locale: 'zh-CN',
            },
            params: {
              page_size: 20,
              user_id_type: 'open_id',
            },
          });

          if (res.code === 0 && (res?.data?.instance_list || []).length > 0) {
            return { ok: true, list: res.data.instance_list };
          }
        } catch (err) {
          // 编号直查失败时继续执行兜底策略
          console.warn('[QUERY QUICK CHECK MISS]', err.message);
        }
      }
    }

    const list = [];
    let pageToken = '';
    let page = 0;

    const now = Date.now();
    const from = String(now - 90 * 24 * 60 * 60 * 1000);
    const to = String(now + 60 * 1000);

    while (page < 10) {
      page += 1;
      const data = {
        instance_status: 'ALL',
        locale: 'zh-CN',
        instance_start_time_from: from,
        instance_start_time_to: to,
      };
      if (instanceTitle) data.instance_title = instanceTitle;
      if (applicantOpenId) data.user_id = applicantOpenId;

      const res = await client.approval.v4.instance.query({
        data,
        params: {
          page_size: 100,
          page_token: pageToken || undefined,
          user_id_type: 'open_id',
        },
      });

      if (res.code !== 0) {
        return { ok: false, error: `${res.msg || '审批查询失败'} (code=${res.code})` };
      }

      const pageList = res?.data?.instance_list || [];
      list.push(...pageList);

      if (serialNo) {
        const hit = pageList.find((item) => `${item?.instance?.serial_id || ''}` === `${serialNo}`);
        if (hit) {
          return { ok: true, list };
        }
      }

      pageToken = res?.data?.page_token || '';
      if (!pageToken) break;
    }

    return { ok: true, list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function pickBestInstance(list, { serialNo, instanceTitle }) {
  if (!Array.isArray(list) || list.length === 0) return null;

  if (serialNo) {
    const exact = list.find((item) => `${item?.instance?.serial_id || ''}` === `${serialNo}`);
    if (exact) return exact;
  }

  if (instanceTitle) {
    const byTitle = list.find((item) => `${item?.instance?.title || ''}`.includes(instanceTitle));
    if (byTitle) return byTitle;
  }

  return list
    .slice()
    .sort((a, b) => Number(b?.instance?.start_time || 0) - Number(a?.instance?.start_time || 0))[0];
}

async function fetchApprovalDetailByCode(instanceCode) {
  try {
    const res = await client.approval.v4.instance.get({
      path: {
        instance_id: instanceCode,
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
