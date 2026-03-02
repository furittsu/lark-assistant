const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();
const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.send('Lark approval assistant is running.');
});

app.post('/webhook/lark/events', async (req, res) => {
  const body = req.body || {};

  if (body.type === 'url_verification' && body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  console.log('[LARK EVENT]', JSON.stringify(body));

  const suggestion = await getAiSuggestion('请根据审批要点给出通过/拒绝建议，并列出风险点。');
  console.log('[AI SUGGESTION]', suggestion);

  return res.json({ code: 0, msg: 'ok' });
});

app.post('/webhook/lark/card-actions', async (req, res) => {
  const body = req.body || {};
  console.log('[CARD ACTION]', JSON.stringify(body));

  return res.json({
    toast: {
      type: 'success',
      content: '已收到你的操作，后续会执行审批动作。'
    }
  });
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
        temperature: 0.2
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return resp.data?.choices?.[0]?.message?.content || 'AI 无返回内容';
  } catch (err) {
    return `AI 调用失败: ${err.message}`;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
