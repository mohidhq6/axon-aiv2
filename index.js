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
app.use(bodyParser.urlencoded({ extended: false }));

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Helper: Create Solved PDF ----------
async function generateSolvedPDF(question, answer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const text = `Worksheet Question(s):\n\n${question}\n\n---\n\nAxon AI Solution:\n\n${answer}`;
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

// ---------- Slack Event Handler ----------
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;

    // Slack verification handshake
    if (challenge) return res.status(200).send(challenge);

    // Respond quickly to avoid Slack timeouts
    res.status(200).send();

    if (!event || event.type !== "app_mention") return;

    const userPrompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // Check if a file is attached
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileType = file.mimetype;

      try {
        // Download file from Slack
        const response = await axios.get(file.url_private_download, {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });

        let extractedText = "";

        if (fileType === "application/pdf") {
          const pdfData = await pdfParse(response.data);
          extractedText = pdfData.text.trim();
        } else if (fileType.startsWith("image/")) {
          extractedText = "This is an image. Please describe the question visually.";
        } else {
          await slackClient.chat.postMessage({
            channel: event.channel,
            text: "❌ Unsupported file type. Please upload a PDF or an image.",
            thread_ts: event.ts,
          });
          return;
        }

        // Solve using OpenAI
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are Axon AI, an expert educational tutor. Solve worksheets clearly and neatly. Include step-by-step reasoning.",
            },
            { role: "user", content: extractedText },
          ],
        });

        const answer = aiResponse.choices[0].message.content || "No answer generated.";

        // Generate solved PDF
        const solvedFilePath = await generateSolvedPDF(extractedText, answer);

        // Upload solved PDF using files.uploadV2
        await slackClient.files.uploadV2({
          channel_id: event.channel,
          initial_comment: "✅ Here’s your solved worksheet, completed by Axon AI:",
          file: fs.createReadStream(solvedFilePath),
          filename: "axon_solution.pdf",
          title: "Axon AI Solved Worksheet",
        });

        fs.unlinkSync(solvedFilePath);
      } catch (err) {
        console.error("File handling error:", err);
        await slackClient.chat.postMessage({
          channel: event.channel,
          text:
            "⚠️ Sorry — I couldn’t process that file. It may be scanned, password-protected, or corrupted.",
          thread_ts: event.ts,
        });
      }

      return;
    }

    // ---------- Regular Chat Questions ----------
    const aiChat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a friendly, expert tutor. Provide clear, concise educational explanations in chat.",
        },
        { role: "user", content: userPrompt },
      ],
    });

    const chatAnswer = aiChat.choices[0].message.content;

    await slackClient.chat.postMessage({
      channel: event.channel,
      text: chatAnswer,
      thread_ts: event.ts,
    });
  } catch (error) {
    console.error("Slack event error:", error);
  }
});

app.listen(port, () => console.log(`🚀 Axon AI running on port ${port}`));
