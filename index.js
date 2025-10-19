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

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: Generate a solved PDF
async function generateSolvedPDF(question, answer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
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

// --- SLACK EVENTS HANDLER ---
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;

    // Slack verification
    if (challenge) return res.status(200).send(challenge);

    // Respond immediately so Slack doesn’t timeout
    res.status(200).send();

    if (!event || event.type !== "app_mention") return;

    // Remove bot mention from text
    const prompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // Check if there are any attached files (like a worksheet)
    if (event.files && event.files.length > 0) {
      const file = event.files[0];

      if (file.mimetype === "application/pdf") {
        // Download the PDF
        const pdfUrl = file.url_private_download;
        const response = await axios.get(pdfUrl, {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });

        // Extract text from the PDF
        const pdfData = await pdfParse(response.data);
        const textContent = pdfData.text.trim();

        // Ask OpenAI to solve the worksheet
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are Axon AI, an expert IGCSE tutor. Read the worksheet and provide clear, step-by-step answers.",
            },
            { role: "user", content: textContent },
          ],
        });

        const answer = aiResponse.choices[0].message.content;

        // Generate and upload solved PDF
        const solvedFilePath = await generateSolvedPDF(textContent, answer);

        await slackClient.files.upload({
          channels: event.channel,
          initial_comment: "Here’s your solved worksheet 📘",
          file: fs.createReadStream(solvedFilePath),
          filename: "axon_solution.pdf",
        });

        fs.unlinkSync(solvedFilePath);
        return;
      }
    }

    // --- Otherwise, handle as a normal text question ---
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a friendly and knowledgeable IGCSE tutor. Reply directly in chat with clear, concise explanations.",
        },
        { role: "user", content: prompt },
      ],
    });

    const answer = chatResponse.choices[0].message.content;

    // Reply in Slack
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
