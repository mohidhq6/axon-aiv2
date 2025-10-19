import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import { buildGraderPrompt } from './graderPrompt.js';

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
    if (challenge) return res.send(challenge);
    if (event && event.type === "app_mention") {
      const prompt = event.text.replace(/<@\w+>/, "").trim();
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are Axon AI, a smart and friendly IGCSE tutor for Physics, Chemistry, Biology, Math, and English." },
          { role: "user", content: prompt }
        ],
      });
      const answer = response.choices[0].message.content;
      await slackClient.chat.postMessage({ channel: event.channel, text: answer });
    }
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
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
