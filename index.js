import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import axios from "axios";
import pdfParse from "pdf-parse";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import Tesseract from "tesseract.js";

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

// ---------- OCR Helper ----------
async function extractTextFromImage(imageBuffer) {
  try {
    const { data } = await Tesseract.recognize(imageBuffer, "eng", {
      logger: (m) => console.log(m.status),
    });
    return data.text.trim();
  } catch (err) {
    console.error("OCR error:", err);
    return "";
  }
}

// ---------- Slack Event Handler ----------
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);
    res.status(200).send(); // Immediate response to Slack

    if (!event || event.type !== "app_mention") return;

    const userPrompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // --------- If file is attached ---------
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileType = file.mimetype;

      try {
        const response = await axios.get(file.url_private_download, {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });

        let extractedText = "";

        if (fileType === "application/pdf") {
          const pdfData = await pdfParse(response.data);
          extractedText = pdfData.text.trim();
        } else if (fileType.startsWith("image/")) {
          extractedText = await extractTextFromImage(response.data);
          if (!extractedText)
            extractedText =
              "I couldn’t read the image clearly. Please reupload a sharper version or type the question.";
        } else {
          await slackClient.chat.postMessage({
            channel: event.channel,
            text: "❌ Unsupported file type. Please upload a PDF or image.",
            thread_ts: event.ts,
          });
          return;
        }

        // --------- Generate AI solution ---------
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are Axon AI, a smart educational tutor. Read the worksheet text and solve step-by-step with clarity.",
            },
            { role: "user", content: extractedText },
          ],
        });

        const answer = aiResponse.choices[0].message.content || "No solution generated.";

        // Create solved PDF
        const solvedFilePath = await generateSolvedPDF(extractedText, answer);

        // Upload to Slack
        await slackClient.files.uploadV2({
          channel_id: event.channel,
          initial_comment: "✅ Here’s your solved worksheet, completed by Axon AI:",
          file: fs.createReadStream(solvedFilePath),
          filename: "axon_solution.pdf",
          title: "Axon AI Solved Worksheet",
        });

        fs.unlinkSync(solvedFilePath);
      } catch (err) {
        console.error("File processing error:", err);
        await slackClient.chat.postMessage({
          channel: event.channel,
          text:
            "⚠️ Sorry, I couldn’t process that file. It may be too blurry or corrupted. Try again with a clearer upload.",
          thread_ts: event.ts,
        });
      }
      return;
    }

    // --------- Regular chat (no file) ---------
    const aiChat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a friendly, expert tutor. Give short, clear explanations and examples.",
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

app.listen(port, () => console.log(`🚀 Axon AI running with OCR on port ${port}`));
