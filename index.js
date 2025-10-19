import express from "express";
import pkg from "@slack/bolt";
import fs from "fs";
import pdfParse from "pdf-parse";
import axios from "axios";

const { App } = pkg;

// Initialize Slack Bolt app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Express server for Render health check
const expressApp = express();
const PORT = process.env.PORT || 10000;

// Health endpoint
expressApp.get("/", (req, res) => {
  res.send("✅ Axon AI is alive and running!");
});

// Handle text messages sent to the bot
app.message(async ({ message, say }) => {
  if (!message.text || message.subtype === "bot_message") return;

  const userText = message.text.trim().toLowerCase();

  if (userText.includes("hello") || userText.includes("hi")) {
    await say(`Hey there <@${message.user}> 👋 How can I help you today?`);
    return;
  }

  await say("Got it! Processing your message...");
  // Your logic to handle the message (AI or otherwise) goes here.
});

// Handle PDF or image uploads
app.event("message", async ({ event, client }) => {
  if (!event.files) return;

  for (const file of event.files) {
    if (file.mimetype === "application/pdf") {
      const fileUrl = file.url_private_download;
      try {
        const pdfResponse = await axios.get(fileUrl, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          responseType: "arraybuffer",
        });
        const pdfData = await pdfParse(pdfResponse.data);
        await client.chat.postMessage({
          channel: event.channel,
          text: `I read your PDF titled *${file.name}* — here's the extracted text:\n\n${pdfData.text.slice(0, 1000)}...`,
        });
      } catch (err) {
        console.error("PDF error:", err);
      }
    } else if (file.mimetype.startsWith("image/")) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `I received your image *${file.name}*! (Image analysis feature coming soon 🔍)`,
      });
    }
  }
});

// Start both servers
(async () => {
  try {
    await app.start(PORT);
    expressApp.listen(PORT, () => {
      console.log(`✅ Axon AI is running on port ${PORT}`);
    });
    console.log("⚡️ Bolt app is running!");
  } catch (error) {
    console.error("Failed to start app:", error);
  }
})();
