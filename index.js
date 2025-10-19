import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildGraderPrompt } from "./graderPrompt.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Respond to mentions (@Axon AI)
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;

    // Slack URL verification
    if (challenge) return res.status(200).send(challenge);

    // Always respond immediately so Slack doesn't timeout
    res.status(200).send();

    // Handle only app mentions (@Axon AI)
    if (event && event.type === "app_mention") {
      const prompt = event.text.replace(/<@\w+>\s*/, "").trim();

      // Get answer from OpenAI
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are Axon AI, a smart and friendly IGCSE tutor for Physics, Chemistry, Biology, Math, and English.",
          },
          { role: "user", content: prompt },
        ],
      });

      const answer = response.choices[0].message.content;

      // Create a solved PDF with Q&A
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]); // A4
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 12;

      const text = `Question:\n${prompt}\n\nAnswer:\n${answer}`;
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

      // Upload the PDF to Slack
      await slackClient.files.upload({
        channels: event.channel,
        initial_comment: "Here’s your solved PDF 📘",
        file: fs.createReadStream(filePath),
        filename: "axon_solution.pdf",
      });

      // Cleanup
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Error handling Slack event:", error);
  }
});

// Slash commands: /explain, /quiz, /check
app.post("/slack/commands", async (req, res) => {
  const { command, text } = req.body;
  let prompt = "";

  if (command === "/explain") {
    prompt = `Explain the following IGCSE concept clearly: ${text}`;
  } else if (command === "/quiz") {
    prompt = `Create a short IGCSE quiz with 3 questions on this topic: ${text}`;
  } else if (command === "/check") {
    prompt = buildGraderPrompt(text);
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are Axon AI, a helpful IGCSE tutor." },
        { role: "user", content: prompt },
      ],
    });

    res.send(response.choices[0].message.content);
  } catch (err) {
    console.error(err);
    res.send("Something went wrong. Please try again.");
  }
});

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
