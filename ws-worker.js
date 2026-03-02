const Lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
const dotenv = require('dotenv');

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

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});

const handlers = {};
const seenEventIds = new Set();

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
      const suggestion = await getAiSuggestion(
        `你是审批助手。请基于以下事件给出：建议结论、风险点、建议操作。事件：${JSON.stringify(data)}`
      );
      console.log('[AI SUGGESTION]', suggestion);
    });

    return { ok: true };
  };
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
