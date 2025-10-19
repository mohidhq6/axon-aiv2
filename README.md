# Axon AI — Slack Tutor Bot

Axon AI is a GPT-4o-powered IGCSE tutoring assistant for Slack.

## 🚀 Quick Setup (No Coding)

1. **Upload this folder to a new GitHub repo.**
2. Go to [Render.com](https://render.com) → click “New +” → “Web Service” → Connect your GitHub repo.
3. Render will detect the included `render.yaml` file and pre-fill all settings.
4. Add these **Environment Variables** in Render:
   - `OPENAI_API_KEY`
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `PORT` = `10000`
5. Click **Deploy**.

When it's live, connect it to Slack:
- Go to your Slack App → Event Subscriptions →
  - Enable → Request URL: `https://your-app-name.onrender.com/slack/events`
  - Add `app_mention` event
- Add Slash Commands:
  - `/explain`, `/quiz`, `/check` → each with Request URL `https://your-app-name.onrender.com/slack/commands`
- Reinstall your app in Slack, then type `@Axon AI explain Newton's laws`.

You're done 🎉
