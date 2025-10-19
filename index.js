import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import fs from "fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import pdfParse from "pdf-parse";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// helper: create a PDF from text
async function createPdfFromText(text, filename = "axon_solution.pdf") {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const lines = text.split("\n");
  let y = 800;
  for (let line of lines) {
    page.drawText(line, { x: 50, y, size: fontSize, font, color: rgb(0, 0, 0) });
    y -= 16;
    if (y < 50) {
      page = pdfDoc.addPage([595, 842]);
      y = 800;
    }
  }

  const pdfBytes = await pdfDoc.save();
  const path = `./${filename}`;
  fs.writeFileSync(path, pdfBytes);
  return path;
}

app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);

    res.status(200).send(); // immediate 200 for Slack

    if (event.type !== "app_mention") return;

    const textPrompt = (event.text || "").replace(/<@[\w]+>/, "").trim();

    // 📘 CASE 1 — user attached a PDF
    if (event.files && event.files.length > 0) {
      const pdfFile = event.files.find(f => f.mimetype === "application/pdf");
      if (!pdfFile) {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "Please attach a PDF file.",
        });
        return;
      }

      // download the PDF
      const fileInfo = await slackClient.files.info({ file: pdfFile.id });
      const url = fileInfo.file.url_private_download;

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const buffer = Buffer.from(await response.arrayBuffer());

      const data = await pdfParse(buffer);
      const extractedText = data.text.trim();

      if (!extractedText) {
        await slackClient.chat.postMessage({
          channel: event.channel,
          text: "Couldn't read text from this PDF.",
        });
        return;
      }

      // send to OpenAI for solving
      const aiResp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are Axon AI, a friendly IGCSE tutor." },
          { role: "user", content: `Solve the questions in this text:\n${extractedText}` },
        ],
      });

      const answer = aiResp.choices[0].message.content;

      // make PDF
      const solvedPath = await createPdfFromText(answer, "axon_solution.pdf");

      // upload solved PDF
      await slackClient.files.uploadV2({
        channel_id: event.channel,
        initial_comment: "Here’s your solved PDF 📘",
        filename: "axon_solution.pdf",
        file: fs.createReadStream(solvedPath),
      });

      fs.unlinkSync(solvedPath);

      // short text reply too
      await slackClient.chat.postMessage({
        channel: event.channel,
        text: "✅ Solved! See attached PDF.",
      });
      return;
    }

    // 💬 CASE 2 — no file attached (normal chat)
    const chatResp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are Axon AI, a smart and friendly IGCSE tutor for Physics, Chemistry, Biology, Math, and English.",
        },
        { role: "user", content: textPrompt },
      ],
    });

    const reply = chatResp.choices[0].message.content;
    await slackClient.chat.postMessage({ channel: event.channel, text: reply });
  } catch (err) {
    console.error("Slack event error:", err);
  }
});

app.listen(port, () => console.log(`✅ Axon AI running on port ${port}`));
