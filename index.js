// index.js — ES module, production-ready Slack bot
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "@slack/bolt";
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import { createWorker } from "tesseract.js";

dotenv.config();
const { App, ExpressReceiver } = pkg;

// ---- Basic config & validation ----
const PORT = Number(process.env.PORT || 10000);
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !OPENAI_API_KEY) {
  console.error("ERROR: Set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and OPENAI_API_KEY in environment.");
  process.exit(1);
}

// ---- Express app for Render + use with ExpressReceiver ----
const expressApp = express();
expressApp.use(bodyParser.json());
expressApp.get("/", (req, res) => res.send("Axon AI — alive"));

// ---- Slack receiver wired to Express ----
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
  expressApp,
});

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Tesseract worker (shared) ----
const ocrWorker = createWorker({
  logger: /* optional */ m => { /* console.log("OCR:", m); */ },
});
let ocrReady = false;

async function initOcr() {
  try {
    await ocrWorker.load();
    await ocrWorker.loadLanguage("eng");
    await ocrWorker.initialize("eng");
    ocrReady = true;
    console.log("✅ OCR worker initialized");
  } catch (e) {
    console.error("Failed to init OCR:", e);
    ocrReady = false;
  }
}

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
  // Using pdfjs-dist legacy build (ESM-safe)
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ");
    fullText += `\n\n--- Page ${i} ---\n${pageText}`;
  }
  return fullText.trim();
}

async function extractTextFromImageBuffer(buffer) {
  if (!ocrReady) {
    await initOcr();
    if (!ocrReady) throw new Error("OCR unavailable");
  }
  const { data } = await ocrWorker.recognize(buffer);
  return (data && data.text) ? data.text.trim() : "";
}

async function askOpenAI(systemPrompt, userContent, model = "gpt-4o-mini") {
  // Send a chat completion request and return the assistant text
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return resp?.choices?.[0]?.message?.content ?? "";
}

// ---- Main behavior: respond to @mentions ----
slackApp.event("app_mention", async ({ event, client, logger }) => {
  try {
    const mentionText = (event.text || "").replace(/<@[^>]+>/g, "").trim() || "";

    // If files attached (process first file)
    if (Array.isArray(event.files) && event.files.length > 0) {
      const file = event.files[0];
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "🔍 Received your file. Working on it now — I'll post the solution in this thread.",
      });

      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Cannot access the uploaded file." });
        return;
      }

      const buffer = await downloadFileBuffer(downloadUrl);
      let extractedText = "";

      // Determine type and extract
      const mimetype = (file.mimetype || "").toLowerCase();
      if (mimetype.includes("pdf") || (file.filetype && file.filetype === "pdf")) {
        extractedText = await extractTextFromPDFBuffer(buffer);
        // If extracted text is tiny, try OCR fallback by rendering pages to images (advanced) — skip for now
      } else if (mimetype.startsWith("image/")) {
        extractedText = await extractTextFromImageBuffer(buffer);
      } else {
        await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Unsupported file type. I support PDFs and images." });
        return;
      }

      if (!extractedText || extractedText.trim().length < 10) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Could not extract readable text from that file. Try a clearer scan or a text-PDF." });
        return;
      }

      // Ask OpenAI to solve the worksheet/questions. Keep the system instruction specific.
      const system = "You are Axon AI, an expert IGCSE tutor. For the provided worksheet text, produce clear, numbered, step-by-step solutions for each question present. If there are diagrams referenced, explain assumptions. Use concise, exam-grade answers.";
      const solution = await askOpenAI(system, extractedText, "gpt-4o");

      // Post the solution in the thread (text directly)
      // If solution is extremely long, consider truncating or splitting into multiple messages
      const MAX_LEN = 3000;
      if (solution.length <= MAX_LEN) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `✅ Solved worksheet:\n\n${solution}` });
      } else {
        // split into chunks
        const parts = [];
        for (let i = 0; i < solution.length; i += MAX_LEN) parts.push(solution.slice(i, i + MAX_LEN));
        for (const p of parts) {
          await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: p });
        }
      }

      return;
    }

    // Otherwise: simple chat question — reply in thread concisely
    if (!mentionText) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Hi — ask me a question or attach a worksheet and mention me." });
      return;
    }

    const sys = "You are Axon AI, a friendly, accurate IGCSE tutor. Answer concisely and include step-by-step working when relevant.";
    const reply = await askOpenAI(sys, mentionText, "gpt-4o-mini");

    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: reply });

  } catch (err) {
    logger.error(err);
    try {
      await slackApp.client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⚠️ Sorry — I couldn't complete that. Try again or upload a clearer image/PDF.",
      });
    } catch (e) {
      console.error("Failed posting error message:", e);
    }
  }
});

// ---- Start everything ----
(async () => {
  // initialize OCR worker in background
  initOcr().catch((e) => console.warn("OCR init failed:", e));

  try {
    // Start Bolt listener (this will attach the ExpressReceiver to expressApp)
    await slackApp.start(PORT);
    console.log(`✅ Axon AI running (Bolt) on port ${PORT}`);
    // expressApp already handles "/" and receiver is mounted at /slack/events by ExpressReceiver
  } catch (e) {
    console.error("Failed to start Axon AI:", e);
    process.exit(1);
  }
})();
