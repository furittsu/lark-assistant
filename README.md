# lark-approval-ai

## Local run
npm install
cp .env.example .env
npm run dev

## Endpoints
- POST /webhook/lark/events
- POST /webhook/lark/card-actions

## Long connection quick use
1. Start worker: `npm run ws`
2. Send a text message to bot with approval content.
3. Include keyword `审核` or `审批` in message, bot will auto analyze and reply.
4. For AP2-3 rules, include `AP2-3` in the text.
