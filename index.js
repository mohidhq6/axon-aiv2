// index.js — CommonJS version (Render-safe)

require("dotenv").config();
const { App } = require("@slack/bolt");
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 10000;

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// helper: get text from pdf
async function extractTextFromPDF(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const parsed = await pdf(dataBuffer);
  return parsed.text || "";
}

// event: app mention
slackApp.event("app_mention", async ({ event, client }) => {
  try {
    const userMessage = event.text.replace(/<@[^>]+>/, "").trim();

    // If file attached
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileUrl = file.url_private_download;
      const tempPath = path.join("/tmp", file.name);

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "📄 Processing your worksheet — please wait a moment.",
      });

      // Download file
      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(tempPath, Buffer.from(buffer));

      // Extract text
      const text = await extractTextFromPDF(tempPath);
      if (!text || text.trim().length < 5) throw new Error("Empty PDF text");

      // Solve using GPT
      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful academic assistant. Read the worksheet and give full, clear, step-by-step answers in text only.",
          },
          { role: "user", content: text },
        ],
      });

      const answer = gptRes.choices[0].message.content;

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `✅ Here's the solved worksheet:\n\n${answer}`,
      });

      fs.unlinkSync(tempPath);
    } else {
      // Normal question
      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a knowledgeable academic tutor. Answer user questions directly and clearly in text form.",
          },
          { role: "user", content: userMessage },
        ],
      });

      const reply = gptRes.choices[0].message.content;
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: reply,
      });
    }
  } catch (err) {
    console.error("Error:", err);
    await slackApp.client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "⚠️ Sorry, something went wrong while processing your request.",
    });
  }
});

// start server
(async () => {
  await slackApp.start(PORT);
  console.log(`🚀 Axon AI is running on port ${PORT}`);
})();
