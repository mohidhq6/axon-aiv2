# Axon AI — PDF Solver (Ready to Deploy)

This package lets Axon AI receive a PDF in Slack (when mentioned), solve the questions using OpenAI, create a solved PDF (questions + full step-by-step answers), and upload it back to the channel.

## What to upload to Render
- index.js
- package.json
- .env.example (for reference; don't put real keys in repo)

## Render settings
- Root directory: leave blank
- Build command: npm install
- Start command: node index.js
- Env vars to add in Render (Environment):
  - OPENAI_API_KEY = your_openai_key_here
  - SLACK_BOT_TOKEN = xoxb-...
  - SLACK_SIGNING_SECRET = your signing secret
  - PORT = 10000

## Slack app requirements
- Bot Token Scopes (OAuth & Permissions):
  - chat:write
  - files:read
  - files:write
  - app_mentions:read
  - channels:history
  - commands (optional)
- Event Subscriptions:
  - Enable Events: ON
  - Request URL: https://<your-render-url>/slack/events
  - Subscribe to bot events: add `app_mention`

## How to test
1. Upload this ZIP to GitHub and connect to Render, or use Render's "Deploy from ZIP" feature.
2. Add the environment variables on Render.
3. Deploy and wait until the service is live.
4. In Slack, invite the bot to a channel: /invite @Axon AI
5. In that channel, upload a PDF and mention the bot: @Axon AI solve this
6. Wait — the bot will reply and upload a solved PDF.

## Notes
- The bot expects text-based PDFs (not scanned images). For scanned PDFs, OCR is required (not included).
- The code trims long PDFs to keep token usage reasonable; you may need to break very long PDFs into smaller files.
- Billing: each solve uses OpenAI tokens — monitor your OpenAI usage and quota.
