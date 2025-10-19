import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import axios from "axios";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: Create a solved PDF that contains original text then AI answers (full explanations)
async function createSolvedPDF(originalText, answersText, filename) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filename);
      doc.pipe(stream);

      doc.fontSize(18).text("Axon AI — Solved Paper", { align: "center" });
      doc.moveDown();

      doc.fontSize(12).fillColor("black").text("Original extracted text from uploaded PDF:", { underline: true });
      doc.moveDown(0.5);
      // split original text into paragraphs
      originalText.split('\n').forEach(line => {
        if (line.trim()) {
          doc.fontSize(11).text(line.trim(), { continued: false });
        } else {
          doc.moveDown(0.2);
        }
      });

      doc.addPage();
      doc.fontSize(14).fillColor("black").text("Axon AI — Answers (full, step-by-step explanations):", { underline: true });
      doc.moveDown();

      // write answers
      answersText.split('\n').forEach(line => {
        if (line.trim()) {
          doc.fontSize(11).fillColor("black").text(line.trim());
        } else {
          doc.moveDown(0.2);
        }
      });

      doc.end();
      stream.on("finish", () => resolve(filename));
    } catch (err) {
      reject(err);
    }
  });
}

app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;

    // Slack url_verification
    if (challenge) return res.status(200).send(challenge);

    // Acknowledge immediately
    res.status(200).send();

    // Only handle app_mention events
    if (!event || event.type !== "app_mention") return;

    // If there are files attached, prefer handling the first PDF
    if (event.files && event.files.length > 0) {
      const file = event.files[0];

      if (file.mimetype !== "application/pdf") {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "I currently only accept PDF files. Please upload a PDF and mention me (e.g. @Axon AI solve this).",
        });
        return;
      }

      // Notify user we started processing
      await slackClient.chat.postMessage({
        channel: event.channel,
        text: `Received ${file.name}. I will process and upload a solved PDF when ready — this may take a moment.`,
      });

      // Download file from Slack (url_private_download requires auth)
      const pdfResp = await axios.get(file.url_private_download, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });

      const buffer = Buffer.from(pdfResp.data);

      // Extract text from PDF
      let pdfData;
      try {
        pdfData = await pdfParse(buffer);
      } catch (e) {
        console.error("PDF parse error:", e);
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "Sorry — I couldn't extract text from that PDF. Make sure it's a text-based PDF (not a scanned image).",
        });
        return;
      }

      const extractedText = (pdfData && pdfData.text) ? pdfData.text.slice(0, 20000) : "";

      if (!extractedText || extractedText.trim().length < 10) {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "I couldn't find readable text in the PDF. If it's a scanned image, try uploading a text PDF or an image with OCR.",
        });
        return;
      }

      // Build prompt for OpenAI to provide full step-by-step answers.
      const systemPrompt = "You are Axon AI, an experienced IGCSE tutor. Provide clear, step-by-step solutions and explanations for the questions below. Use student-friendly language and show workings where appropriate.";

      const userPrompt = `Below is the extracted text from a PDF containing IGCSE-style questions. Provide clear, labeled answers for each question and show full step-by-step working where applicable. If a question is ambiguous, state assumptions briefly before answering.

---- PDF TEXT START ----
${extractedText}
---- PDF TEXT END ----

Provide the answers in a numbered format, matching question order where possible.`;

      // Call OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 3000,
      });

      const answersText = completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content
        ? completion.choices[0].message.content
        : "Sorry, I couldn't generate answers for this file.";

      // Create solved PDF combining original extracted text and answers
      const filename = `solved-${Date.now()}.pdf`;
      try {
        await createSolvedPDF(extractedText, answersText, filename);
      } catch (e) {
        console.error("Error creating PDF:", e);
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "I ran into an error while creating the solved PDF.",
        });
        return;
      }

      // Upload solved PDF to Slack
      try {
        await slackClient.files.upload({
          channels: event.channel,
          initial_comment: "Here's the solved PDF (questions + full step-by-step answers).",
          file: fs.createReadStream(filename),
          filename: filename,
        });
      } catch (e) {
        console.error("Slack file upload error:", e);
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "I couldn't upload the solved PDF — please check my file permissions (files:write).",
        });
        return;
      } finally {
        // clean up local file
        try { fs.unlinkSync(filename); } catch (e) {}
      }

    } else {
      // No files attached — ask user to attach a PDF
      await slackClient.chat.postMessage({
        channel: event.channel,
        text: "Please attach a PDF and mention me (e.g. @Axon AI solve this).",
      });
    }
  } catch (err) {
    console.error("Error in /slack/events:", err);
  }
});

// Keep existing slash commands or other endpoints if needed
app.post("/slack/commands", async (req, res) => {
  res.status(200).send("Slash commands are not enabled for PDF solving in this deployment.");
});

app.get("/", (req, res) => res.send("Axon AI (PDF-solver) is running."));

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
