const { App } = require("@slack/bolt");
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  appToken: process.env.SLACK_APP_TOKEN
});

// 🧩 Handle messages and file uploads
slackApp.message(async ({ message, say, client }) => {
  try {
    if (message.files && message.files.length > 0) {
      const file = message.files[0];
      const fileUrl = file.url_private_download;
      await say("📄 Processing your worksheet — please wait a moment.");

      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const arrayBuffer = await response.arrayBuffer();
      const pdfData = await pdfParse(Buffer.from(arrayBuffer));
      const text = pdfData.text.slice(0, 8000); // Limit text for prompt

      const openai = (await import("openai")).default;
      const openaiClient = new openai({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a tutor who solves worksheets and explains clearly. Return the solved answers in simple text."
          },
          { role: "user", content: text }
        ]
      });

      await say(`✅ Here's the solved worksheet:\n${completion.choices[0].message.content}`);
    } else if (message.text) {
      const prompt = message.text;

      const openai = (await import("openai")).default;
      const openaiClient = new openai({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a subject expert tutor answering concisely." },
          { role: "user", content: prompt }
        ]
      });

      await say(completion.choices[0].message.content);
    }
  } catch (error) {
    console.error("Error processing message:", error);
    await say("⚠️ Sorry, something went wrong while processing your request.");
  }
});

// 🖥️ Express for Render health check
app.get("/", (req, res) => res.send("Axon AI is running 🚀"));
const port = process.env.PORT || 10000;

(async () => {
  await slackApp.start(port);
  console.log(`✅ Axon AI is running on port ${port}`);
})();
