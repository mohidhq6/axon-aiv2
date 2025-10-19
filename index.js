import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import axios from "axios";
import Tesseract from "tesseract.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js"; // ✅ replaces pdf-parse

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ✅ Extracts text from PDF safely (pdfjs-dist method) */
async function extractTextFromPDF(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(" ");
    fullText += pageText + "\n";
  }

  return fullText.trim();
}

/** Helper: generate solved PDF */
async function generateSolvedPDF(question, answer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const wrappedText = `Question:\n${question}\n\nAnswer:\n${answer}`;
  page.drawText(wrappedText, {
    x: 50,
    y: 750,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
    lineHeight: 16,
    maxWidth: 500,
  });

  const pdfBytes = await pdfDoc.save();
  const filePath = `/tmp/axon_solution.pdf`; // ✅ safe on Render
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
}

/** Main Slack event handler */
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);
    res.status(200).send();

    if (!event || event.type !== "app_mention") return;

    const prompt = event.text?.replace(/<@\w+>\s*/, "").trim() || "";

    // --- Handle PDFs & Images ---
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileUrl = file.url_private_download;
      const fileType = file.mimetype;
      let extractedText = "";

      const fileResponse = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });

      if (fileType === "application/pdf") {
        extractedText = await extractTextFromPDF(fileResponse.data);
      } else if (fileType.startsWith("image/")) {
        const result = await Tesseract.recognize(fileResponse.data, "eng");
        extractedText = result.data.text.trim();
      } else {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "Sorry, I can only process PDFs and images for now.",
          thread_ts: event.ts,
        });
        return;
      }

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are Axon AI, an expert IGCSE tutor. Read the worksheet and provide step-by-step solutions.",
          },
          { role: "user", content: extractedText },
        ],
      });

      const answer = aiResponse.choices[0].message.content;
      const solvedFilePath = await generateSolvedPDF(extractedText, answer);

      await slackClient.files.uploadV2({
        channel_id: event.channel,
        initial_comment: "Here’s your solved worksheet 📘",
        file_uploads: [
          {
            file: fs.createReadStream(solvedFilePath),
            filename: "axon_solution.pdf",
          },
        ],
      });

      fs.unlinkSync(solvedFilePath);
      return;
    }

    // --- Handle text-based chat questions ---
    if (prompt.length > 0) {
      const chatResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Axon AI, a friendly and knowledgeable IGCSE tutor. Reply clearly and concisely.",
          },
          { role: "user", content: prompt },
        ],
      });

      const answer = chatResponse.choices[0].message.content;

      await slackClient.chat.postMessage({
        channel: event.channel,
        text: answer,
        thread_ts: event.ts,
      });
    }
  } catch (error) {
    console.error("Error handling Slack event:", error);
    await slackClient.chat.postMessage({
      channel: req.body?.event?.channel,
      text: "❌ Sorry, something went wrong while processing that.",
      thread_ts: req.body?.event?.ts,
    });
  }
});

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
