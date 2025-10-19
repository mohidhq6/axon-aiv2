// index.js — Final, production-ready Slack bot (ES modules)

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "@slack/bolt";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import Tesseract from "tesseract.js";


dotenv.config();
const { App, ExpressReceiver } = pkg;

// ---- Basic config ----
const PORT = Number(process.env.PORT || 10000);
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

// ---- Express setup ----
const expressApp = express();
expressApp.use(bodyParser.json());
expressApp.get("/", (req, res) => res.send("✅ Axon AI is live"));

// ---- Slack setup ----
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
  expressApp,
});

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Helpers ----

async function downloadFileBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    timeout: 30000,
  });
  return Buffer.from(res.data);
}

async function extractTextFromPDFBuffer(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n\n";
  }
  return text.trim();
}

async function extractTextFromImageBuffer(buffer) {
  try {
    const { data: { text } } = await Tesseract.recognize(buffer, "eng");
    return text.trim();
  } catch (err) {
    console.error("OCR Error:", err);
    return "";
  }
}

async function askOpenAI(systemPrompt, userContent, model = "gpt-4o-mini") {
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return resp?.choices?.[0]?.message?.content ?? "";
}

// ---- Slack behavior ----
slackApp.event("app_mention", async ({ event, client, logger }) => {
  try {
    const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();

    // Handle file uploads
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: ":hourglass: Processing your file...",
      });

      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: "⚠️ Couldn't access file URL.",
        });
        return;
      }

      const buffer = await downloadFileBuffer(downloadUrl);
      let extracted = "";

      const type = (file.mimetype || "").toLowerCase();
      if (type.includes("pdf")) {
        extracted = await extractTextFromPDFBuffer(buffer);
      } else if (type.startsWith("image/")) {
        extracted = await extractTextFromImageBuffer(buffer);
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: "Unsupported file type — only PDFs and images are supported.",
        });
        return;
      }

      if (!extracted || extracted.length < 20) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: "❌ Couldn't read text. Try a clearer file.",
        });
        return;
      }

      const system = "You are Axon AI, an expert IGCSE tutor. Read the worksheet text and provide concise, exam-grade, step-by-step solutions to each question.";
      const solution = await askOpenAI(system, extracted, "gpt-4o");

      const chunks = solution.match(/[\s\S]{1,2800}/g);
      for (const part of chunks) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: part });
      }
      return;
    }

    // Handle plain question
    if (!text) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Hi 👋 — ask me a question or upload a worksheet!",
      });
      return;
    }

    const system = "You are Axon AI, a friendly IGCSE tutor. Provide accurate, concise answers with steps when relevant.";
    const answer = await askOpenAI(system, text);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: answer,
    });
  } catch (err) {
    logger.error("Error handling mention:", err);
    await slackApp.client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "⚠️ Sorry, I ran into an error while processing your request.",
    });
  }
});

// ---- Start server ----
(async () => {
  try {
    await slackApp.start(PORT);
    console.log(`✅ Axon AI running on port ${PORT}`);
  } catch (e) {
    console.error("Failed to start app:", e);
    process.exit(1);
  }
})();
