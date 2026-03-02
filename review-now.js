const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const ruleFile = getArg('--rule', 'rules/ap2-3.json');
  const inputFile = getArg('--input', 'inputs/example-approval.txt');

  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey || !baseUrl) {
    throw new Error('缺少 AI_API_KEY 或 AI_BASE_URL，请先配置 .env');
  }

  const rulePath = path.resolve(ruleFile);
  const inputPath = path.resolve(inputFile);

  if (!fs.existsSync(rulePath)) {
    throw new Error(`规则文件不存在: ${rulePath}`);
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`审批内容文件不存在: ${inputPath}`);
  }

  const rules = fs.readFileSync(rulePath, 'utf8');
  const approvalText = fs.readFileSync(inputPath, 'utf8');

  const prompt = `
你是企业审批助手。请严格按“规则JSON”审核“审批文本”。

要求：
1) 必须先执行规则检查，再给结论。
2) 输出必须包含：建议结论、风险分(0-100)、命中规则、通过理由、风险点、需补充材料、给审批系统的建议填写内容。
3) 建议结论只能是：建议通过 / 建议拒绝 / 建议人工复核。
4) 如果信息不完整，优先建议人工复核，并列出缺失项。
5) 输出语言：简体中文。

规则JSON：
${rules}

审批文本：
${approvalText}
`;

  const resp = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const content = resp.data?.choices?.[0]?.message?.content || 'AI 无返回内容';
  console.log('\n===== AI 审核结果 =====\n');
  console.log(content);
  console.log('\n=======================\n');
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
