import pkg from "@slack/bolt";
const { App } = pkg;
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import Tesseract from "tesseract.js";
import dotenv from "dotenv";
dotenv.config();

// Lazy import for pdf-parse to avoid startup crash
let pdfParse;
async function getPdfParse() {
  if (!pdfParse) pdfParse = (await import("pdf-parse")).default;
  return pdfParse;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

async function createSolvedPDF(question, answer) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  const { height } = page.getSize();
  let y = height - 50;

  const write = (text, size = 12) => {
    const lines = text.split("\n");
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size, font });
      y -= size + 4;
      if (y < 50) {
        y = height - 50;
        pdf.addPage([595, 842]);
      }
    }
  };

  write("QUESTION(S):", 14);
  write(question);
  y -= 14;
  write("SOLUTION(S):", 14);
  write(answer);

  const data = await pdf.save();
  const filePath = `/tmp/axon_solution_${Date.now()}.pdf`;
  fs.writeFileSync(filePath, data);
  return filePath;
}

async function askOpenAI(systemPrompt, userPrompt, model = "gpt-4o") {
  const res = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });
  return res.choices[0].message.content.trim();
}

app.event("app_mention", async ({ event, client }) => {
  try {
    const userText = (event.text || "").replace(/<@[^>]+>/g, "").trim();
    const files = event.files || [];

    if (files.length > 0) {
      const file = files[0];
      const url = file.url_private_download || file.url_private;
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const mime = file.mimetype || "";

      let extracted = "";
      if (mime.includes("pdf")) {
        const pdf = await getPdfParse();
        const data = await pdf(res.data);
        extracted = data.text.trim();
      } else if (mime.startsWith("image/")) {
        const img = Buffer.from(res.data);
        const ocr = await Tesseract.recognize(img, "eng");
        extracted = ocr.data.text.trim();
      }

      if (!extracted) {
        await client.chat.postMessage({
          channel: event.channel,
          text: "Couldn't read that file — please try a clearer PDF or image.",
          thread_ts: event.ts
        });
        return;
      }

      const answer = await askOpenAI(
        "You are Axon AI, a precise IGCSE tutor. Provide full step-by-step solutions.",
        extracted
      );

      const pdfPath = await createSolvedPDF(extracted, answer);

      await client.files.uploadV2({
        channel_id: event.channel,
        initial_comment: "✅ Solved worksheet:",
        file_uploads: [
          {
            file: fs.createReadStream(pdfPath),
            filename: "axon_solution.pdf",
            title: "Axon Solution"
          }
        ]
      });

      fs.unlinkSync(pdfPath);
    } else if (userText) {
      const reply = await askOpenAI(
        "You are Axon AI, a friendly IGCSE tutor. Explain briefly and clearly.",
        userText,
        "gpt-4o-mini"
      );
      await client.chat.postMessage({
        channel: event.channel,
        text: reply,
        thread_ts: event.ts
      });
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        text: "Hi! Upload a PDF/image or ask a question.",
        thread_ts: event.ts
      });
    }
  } catch (err) {
    console.error(err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "⚠️ Something went wrong. Try again.",
      thread_ts: event.ts
    });
  }
});

(async () => {
  const port = process.env.PORT || 10000;
  await app.start(port);
  console.log(`✅ Axon AI is running on port ${port}`);
})();
