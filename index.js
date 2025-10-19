// index.js
import pkg from "@slack/bolt";
const { App } = pkg;

import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import Tesseract from "tesseract.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";

dotenv.config();

const PORT = process.env.PORT || 10000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// -----------------------------
// 🔹 Helper: Extract text from PDFs
// -----------------------------
async function extractTextFromPDF(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ");
    text += `\n\n--- Page ${i} ---\n${pageText}`;
  }

  return text.trim();
}

// -----------------------------
// 🔹 Helper: OCR text from images
// -----------------------------
async function extractTextFromImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng");
  return result.data.text.trim();
}

// -----------------------------
// 🔹 Helper: Ask OpenAI
// -----------------------------
async function askOpenAI(prompt, detailed = false) {
  const model = detailed ? "gpt-4o" : "gpt-4o-mini";
  const system = detailed
    ? "You are Axon AI, an expert IGCSE tutor. Solve the questions carefully, show working where relevant, and format answers clearly."
    : "You are Axon AI, a friendly IGCSE tutor. Explain concepts simply and clearly.";

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });

  return response.choices[0].message.content;
}

// -----------------------------
// 🔹 Helper: Create a solved PDF
// -----------------------------
async function createSolvedPDF(original, solution) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);
  const fontSize = 11;

  const text = `Original Worksheet:\n\n${original.slice(0, 5000)}\n\n---\n\nSolution:\n\n${solution}`;
  const lines = text.match(/.{1,110}/g) || [];

  let y = 800;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: fontSize, font });
    y -= 14;
    if (y < 40) {
      y = 800;
      pdfDoc.addPage();
    }
  }

  const bytes = await pdfDoc.save();
  const path = `/tmp/axon_solution_${Date.now()}.pdf`;
  fs.writeFileSync(path, bytes);
  return path;
}

// -----------------------------
// 🔹 Event Handler: @mention
// -----------------------------
app.event("app_mention", async ({ event, client, logger }) => {
  try {
    const messageText = (event.text || "").replace(/<@[^>]+>/g, "").trim();

    // 🧾 Handle attached files (PDF or image)
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "📘 Processing your worksheet — please wait a moment.",
      });

      const url = file.url_private_download || file.url_private;
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const buffer = Buffer.from(res.data);

      let extracted = "";
      if (file.mimetype.includes("pdf")) extracted = await extractTextFromPDF(buffer);
      else if (file.mimetype.startsWith("image/")) extracted = await extractTextFromImage(buffer);
      else extracted = "Unsupported file type.";

      const solution = await askOpenAI(extracted, true);
      const solvedPath = await createSolvedPDF(extracted, solution);

      await client.files.upload({
        channels: event.channel,
        thread_ts: event.ts,
        file: fs.createReadStream(solvedPath),
        filename: "axon_solution.pdf",
        initial_comment: "✅ Here’s your solved worksheet!",
      });

      fs.unlinkSync(solvedPath);
      return;
    }

    // 💬 Handle regular chat questions
    if (messageText.length > 0) {
      const answer = await askOpenAI(messageText, false);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: answer,
      });
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Hi! Mention me with a question or upload a worksheet for me to solve.",
      });
    }
  } catch (err) {
    logger.error(err);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "⚠️ Sorry, something went wrong while processing your request.",
    });
  }
});

// -----------------------------
// 🔹 Start the App
// -----------------------------
(async () => {
  await app.start(PORT);
  console.log(`✅ Axon AI running on port ${PORT}`);
})();
