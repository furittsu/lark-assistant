const fs = require('fs');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');
require('dotenv').config({ path: '.env' });

const fileArg = process.argv[2] || 'approval-codes.txt';
const filePath = path.resolve(fileArg);

if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
  console.error('缺少 LARK_APP_ID/LARK_APP_SECRET');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`文件不存在: ${filePath}`);
  console.error('请创建 approval-codes.txt，每行一个 approval_code');
  process.exit(1);
}

const codes = fs
  .readFileSync(filePath, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'));

if (codes.length === 0) {
  console.error('approval-codes.txt 为空');
  process.exit(1);
}

const client = new Lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

(async () => {
  let ok = 0;
  let fail = 0;

  for (const code of codes) {
    try {
      const res = await client.approval.v4.approval.subscribe({
        path: { approval_code: code },
      });
      if (res.code === 0) {
        ok += 1;
        console.log(`[OK] ${code}`);
      } else {
        fail += 1;
        console.log(`[FAIL] ${code} -> code=${res.code} msg=${res.msg}`);
      }
    } catch (err) {
      fail += 1;
      const msg = err?.response?.data?.msg || err.message;
      const c = err?.response?.data?.code;
      console.log(`[FAIL] ${code} -> code=${c || 'unknown'} msg=${msg}`);
    }
  }

  console.log(`\n完成: 成功 ${ok}, 失败 ${fail}, 总计 ${codes.length}`);
})();
