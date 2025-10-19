import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { App } from "@slack/bolt";
import pdf from "pdf-parse";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
app.use(bodyParser.json());

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

// handle app mentions (chat or files)
slackApp.event("app_mention", async ({ event, client }) => {
  try {
    const userMessage = event.text.replace(/<@[^>]+>/, "").trim();

    // 1️⃣ Check if a file is attached
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileUrl = file.url_private_download;
      const tempPath = path.join("/tmp", file.name);

      // acknowledge
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "📄 Processing your worksheet — please wait a moment.",
      });

      // download file
      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(tempPath, Buffer.from(buffer));

      // extract text
      const text = await extractTextFromPDF(tempPath);

      if (!text || text.trim().length < 5) {
        throw new Error("Could not extract text from PDF");
      }

      // send to OpenAI for solving
      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful academic assistant. Read worksheet text and provide clear step-by-step answers directly in text format.",
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
      // 2️⃣ Normal question (no file)
      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful academic assistant that answers questions directly in Slack threads. Be concise but clear.",
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

(async () => {
  await slackApp.start(process.env.PORT || 10000);
  console.log(`🚀 Axon AI is running on port ${process.env.PORT || 10000}`);
})();
