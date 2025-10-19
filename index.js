import pkg from "@slack/bolt";
const { App } = pkg;

import OpenAI from "openai";
import axios from "axios";
import Tesseract from "tesseract.js";

// Lazy import for pdf-parse (fixes Render startup error)
let pdfParse;
async function getPdfParse() {
  if (!pdfParse) {
    pdfParse = (await import("pdf-parse")).default;
  }
  return pdfParse;
}

// ---- ENV SETUP ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ---- TEXT MESSAGE HANDLER ----
app.message(async ({ message, say }) => {
  try {
    // Ignore bot messages
    if (message.subtype === "bot_message") return;

    const userMessage = message.text || "";

    // Basic fallback
    if (!userMessage.trim()) {
      await say("Hi there! 👋 How can I help you study today?");
      return;
    }

    // Chat response
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are Axon AI, a patient and smart educational tutor." },
        { role: "user", content: userMessage },
      ],
    });

    const reply = chatResponse.choices[0].message.content;
    await say(reply);
  } catch (error) {
    console.error("Message error:", error);
    await say("❌ Sorry, something went wrong while processing that.");
  }
});

// ---- FILE HANDLER ----
app.event("file_shared", async ({ event, client, say }) => {
  try {
    const fileId = event.file_id;
    const fileInfo = await client.files.info({ file: fileId });
    const file = fileInfo.file;

    const url = file.url_private_download;
    const fileType = file.mimetype;

    const headers = { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };
    const response = await axios.get(url, { responseType: "arraybuffer", headers });

    let extractedText = "";

    // --- PDF handling ---
    if (fileType === "application/pdf") {
      const pdf = await getPdfParse();
      const pdfData = await pdf(response.data);
      extractedText = pdfData.text;
    }

    // --- Image handling (OCR + vision model) ---
    else if (fileType.startsWith("image/")) {
      const ocrResult = await Tesseract.recognize(response.data, "eng");
      const ocrText = ocrResult.data.text.trim();

      const visionResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Axon AI, a helpful educational assistant." },
          { role: "user", content: `Here's the question extracted from an image: ${ocrText}` },
        ],
      });

      extractedText = visionResponse.choices[0].message.content;
    }

    // --- Unsupported file types ---
    else {
      await say("⚠️ Sorry, I can only process PDFs and images for now.");
      return;
    }

    // --- Analyze extracted content ---
    if (!extractedText.trim()) {
      await say("❌ I couldn't extract any text from that file.");
      return;
    }

    const solution = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a teacher that helps solve academic problems clearly." },
        { role: "user", content: `Please analyze and solve this content:\n\n${extractedText}` },
      ],
    });

    await say(solution.choices[0].message.content);
  } catch (error) {
    console.error("File processing error:", error);
    await say("❌ Sorry, something went wrong while processing that.");
  }
});

// ---- START SERVER ----
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`✅ Axon AI is running on port ${port}`);
})();
