import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import pdfParse from "pdf-parse";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import pkg from "@slack/bolt";
import OpenAI from "openai";

const { App } = pkg;

dotenv.config();

// --- Initialize Slack & Express ---
const app = express();
const port = process.env.PORT || 10000;
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// --- Slack SDK Clients ---
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Helper: Create Solved PDF ---
async function createSolvedPDF(question, answer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const text = `Question:\n${question}\n\nAnswer:\n${answer}`;

  page.drawText(text, {
    x: 50,
    y: 750,
    size: 12,
    font,
    color: rgb(0, 0, 0),
    lineHeight: 16,
    maxWidth: 500,
  });

  const pdfBytes = await pdfDoc.save();
  const path = "./axon_solution.pdf";
  fs.writeFileSync(path, pdfBytes);
  return path;
}

// --- Slack Events API endpoint ---
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;

    // Slack verification challenge
    if (challenge) return res.status(200).send(challenge);

    // Respond quickly to Slack
    res.status(200).send();

    if (!event || event.type !== "app_mention") return;

    const prompt = event.text.replace(/<@\w+>\s*/, "").trim();

    // --- Handle if user uploaded a file (PDF or image) ---
    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      const fileUrl = file.url_private_download;
      const headers = { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };

      let extractedText = "";

      if (file.mimetype === "application/pdf") {
        const pdfBuffer = (await axios.get(fileUrl, { responseType: "arraybuffer", headers })).data;
        const pdfData = await pdfParse(pdfBuffer);
        extractedText = pdfData.text;
      } else if (file.mimetype.startsWith("image/")) {
        const base64Image = Buffer.from(
          (await axios.get(fileUrl, { responseType: "arraybuffer", headers })).data
        ).toString("base64");

        const visionResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are an expert tutor. Solve the questions visible in the image clearly.",
            },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: `data:${file.mimetype};base64,${base64Image}`,
                },
              ],
            },
          ],
        });

        extractedText = visionResponse.choices[0].message.content;
      }

      if (extractedText) {
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are Axon AI, a professional IGCSE tutor solving questions clearly and accurately.",
            },
            { role: "user", content: extractedText },
          ],
        });

        const solvedAnswer = aiResponse.choices[0].message.content;

        const solvedPath = await createSolvedPDF(extractedText, solvedAnswer);

        await slackApp.client.files.upload({
          channels: event.channel,
          initial_comment: "Here’s your solved worksheet 📘",
          file: fs.createReadStream(solvedPath),
          filename: "axon_solution.pdf",
        });

        fs.unlinkSync(solvedPath);
        return;
      }
    }

    // --- Otherwise, handle as normal chat question ---
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a smart, friendly tutor that answers IGCSE-level questions clearly and concisely.",
        },
        { role: "user", content: prompt },
      ],
    });

    const reply = chatResponse.choices[0].message.content;

    await slackApp.client.chat.postMessage({
      channel: event.channel,
      text: reply,
      thread_ts: event.ts,
    });
  } catch (err) {
    console.error("Error handling event:", err);
  }
});

// --- Start Server ---
app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
