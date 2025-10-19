import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { WebClient } from "@slack/web-api";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.json());
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Slack Events (Mentions)
app.post("/slack/events", async (req, res) => {
  try {
    const { challenge, event } = req.body;
    if (challenge) return res.status(200).send(challenge);
    res.status(200).send(); // Respond early so Slack doesn't timeout

    // Only handle app mentions
    if (event && event.type === "app_mention") {
      const text = event.text.replace(/<@\w+>/, "").trim();
      const files = event.files || [];

      // 🧾 If PDF is attached
      if (files.length > 0 && files[0].filetype === "pdf") {
        const fileUrl = files[0].url_private_download;
        const headers = { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };

        const pdfBuffer = await fetch(fileUrl, { headers }).then(res => res.arrayBuffer());
        const base64PDF = Buffer.from(pdfBuffer).toString("base64");

        // Ask OpenAI to solve the PDF content
        const solveResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are an expert IGCSE tutor. Solve questions from PDFs step by step." },
            { role: "user", content: "Solve all the questions in this PDF and include both the questions and their full answers." },
            { role: "user", content: [{ type: "input", input: { mime_type: "application/pdf", data: base64PDF } }] }
          ],
        });

        const solutionText = solveResponse.choices[0].message.content;

        // 🧠 Create a new solved PDF
        const doc = new PDFDocument();
        const output = "solved.pdf";
        const stream = fs.createWriteStream(output);
        doc.pipe(stream);
        doc.fontSize(16).text("Solved IGCSE Questions", { align: "center" });
        doc.moveDown();
        doc.fontSize(12).text(solutionText);
        doc.end();

        stream.on("finish", async () => {
          await slackClient.files.upload({
            channels: event.channel,
            initial_comment: "Here’s your solved PDF 📘",
            file: fs.createReadStream(output),
          });
        });
      } else {
        // 🗣 Regular text question
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are Axon AI, a helpful IGCSE tutor." },
            { role: "user", content: text },
          ],
        });

        await slackClient.chat.postMessage({
          channel: event.channel,
