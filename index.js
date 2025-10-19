import pkg from "@slack/bolt";
const { App } = pkg;
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import axios from "axios";
import pdfParse from "pdf-parse";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: Create solved PDF
async function generateSolvedPDF(question, answer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const text = `Question:\n${question}\n\nAnswer:\n${answer}`;
  page.drawText(text, {
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

// Main Slack events endpoint
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);
    res.status(200).send(); // Respond immediately

    if (!event || event.type !== "app_mention") return;

    // Extract user message (remove @mention)
    const prompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // If the user uploaded a file (PDF or image)
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const url = file.url_private_download;

      const response = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });

      let extractedText = "";

      if (file.mimetype === "application/pdf") {
        const pdfData = await pdfParse(response.data);
        extractedText = pdfData.text;
      } else if (file.mimetype.startsWith("image/")) {
        // Use OpenAI Vision to interpret image questions
        const visionResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are Axon AI, an expert tutor. Read the image and explain or solve any visible questions clearly.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Solve the questions shown in this image." },
                { type: "image_url", image_url: url },
              ],
            },
          ],
        });
        extractedText = visionResponse.choices[0].message.content;
      }

      const solveResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are Axon AI, an expert IGCSE tutor. Provide detailed answers to all questions clearly and neatly.",
          },
          { role: "user", content: extractedText },
        ],
      });

      const answer = solveResponse.choices[0].message.content;
      const solvedFilePath = await generateSolvedPDF(extractedText, answer);

      await slackClient.files.uploadV2({
        channel_id: event.channel,
        initial_comment: "Here’s your solved worksheet 📘",
        file: fs.createReadStream(solvedFilePath),
        filename: "axon_solution.pdf",
      });

      fs.unlinkSync(solvedFilePath);
      return;
    }

    // --- Otherwise, handle as a normal text question ---
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a friendly and knowledgeable IGCSE tutor. Reply directly in chat with clear, concise answers.",
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
