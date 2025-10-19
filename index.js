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

// Helper: Create a solved PDF
async function createSolvedPDF(questions, answers, filename) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const writeStream = fs.createWriteStream(filename);
    doc.pipe(writeStream);

    doc.fontSize(18).text("Axon AI - Solved Paper", { align: "center" });
    doc.moveDown();

    questions.forEach((q, i) => {
      doc.fontSize(12).text(`Q${i + 1}: ${q}`);
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor("blue").text(`Answer: ${answers[i]}`);
      doc.moveDown(1);
      doc.fillColor("black");
    });

    doc.end();
    writeStream.on("finish", () => resolve(filename));
  });
}

// Slack Events
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);
    res.status(200).send(); // respond immediately

    if (event && event.type === "app_mention" && event.files && event.files.length > 0) {
      const file = event.files[0];

      // Only process PDFs
      if (file.mimetype !== "application/pdf") {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "Please upload a PDF file for me to solve 📄",
        });
        return;
      }

      // Step 1: Download the PDF
      const pdfUrl = file.url_private_download;
      const pdfResponse = await axios.get(pdfUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        responseType: "arraybuffer",
      });
      const pdfBuffer = Buffer.from(pdfResponse.data);

      // Step 2: Extract text
      const pdfData = await pdfParse(pdfBuffer);
      const text = pdfData.text;

      // Step 3: Send to OpenAI to solve
      const solvePrompt = `
You are Axon AI, an IGCSE tutor. The following are questions from a paper.
Provide clear, step-by-step answers.

Questions:
${text}
`;
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a professional IGCSE tutor." },
          { role: "user", content: solvePrompt },
        ],
      });

      const answersText = response.choices[0].message.content;
      const questions = text.split(/\n\d+[\.\)]/).filter(q => q.trim() !== "");
      const answers = answersText.split(/\n\d+[\.\)]/).filter(a => a.trim() !== "");

      // Step 4: Create solved PDF
      const solvedPath = "solved.pdf";
      await createSolvedPDF(questions, answers, solvedPath);

      // Step 5: Upload solved PDF to Slack
      await slackClient.files.upload({
        channels: event.channel,
        initial_comment: "Here’s your solved paper 📘",
        file: fs.createReadStream(solvedPath),
        filename: "solved.pdf",
      });
    }
  } catch (error) {
    console.error("Error handling Slack event:", error);
  }
});

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
