// index.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import axios from "axios";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Helper to create solved PDF */
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
  const filePath = "./axon_solution.pdf";
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
}

/** Main Slack event handler */
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge); // Slack verification
    res.status(200).send(); // Respond immediately to avoid timeout

    if (!event || event.type !== "app_mention") return;

    const prompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // --- Handle PDFs and Images ---
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileUrl = file.url_private_download;
      const fileType = file.mimetype;

      // Download file from Slack
      const fileResponse = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });

      let extractedText = "";

      if (fileType === "application/pdf") {
        const pdfData = await pdfParse(fileResponse.data);
        extractedText = pdfData.text.trim();
      } else if (fileType.startsWith("image/")) {
        const result = await Tesseract.recognize(fileResponse.data, "eng");
        extractedText = result.data.text.trim();
      }

      // Ask OpenAI to solve the content
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are Axon AI, an expert IGCSE tutor. Provide detailed, clear, step-by-step answers for all worksheet problems.",
          },
          { role: "user", content: extractedText },
        ],
      });

      const answer = aiResponse.choices[0].message.content;

      // Generate solved PDF
      const solvedFilePath = await generateSolvedPDF(extractedText, answer);

      // Upload solved PDF using Slack's modern method
      await slackClient.files.uploadV2({
        channel_id: event.channel,
        initial_comment: "Here’s your solved worksheet 📘",
        file: fs.createReadStream(solvedFilePath),
        filename: "axon_solution.pdf",
        title: "Axon AI Solution",
      });

      fs.unlinkSync(solvedFilePath);
      return;
    }

    // --- Handle text-based questions ---
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a friendly and knowledgeable IGCSE tutor. Reply directly in chat with clear, step-by-step explanations.",
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
  } catch (error) {
    console.error("Error handling Slack event:", error);
  }
});

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
