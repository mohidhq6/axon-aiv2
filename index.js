import express from "express";
import fs from "fs";
import PDFDocument from "pdfkit";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Generate a PDF file with the solved answer
async function generatePDF(question, answer) {
  const filePath = "solve.pdf";
  const doc = new PDFDocument();
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(20).text("Axon AI — Solved PDF", { align: "center" });
  doc.moveDown();
  doc.fontSize(14).text("Question:");
  doc.fontSize(12).text(question);
  doc.moveDown();
  doc.fontSize(14).text("Answer:");
  doc.fontSize(12).text(answer);
  doc.end();

  return new Promise((resolve) => {
    stream.on("finish", () => resolve(filePath));
  });
}

// Endpoint that takes a prompt and returns a solved PDF
app.post("/solve", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt }
      ]
    });

    const answer = completion.choices[0].message.content;
    const pdfPath = await generatePDF(prompt, answer);
    const pdf = fs.readFileSync(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);
  } catch (error) {
    console.error("Error generating solve PDF:", error);
    res.status(500).send("Error generating solve PDF");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Axon AI is running. Use POST /solve with { prompt: 'your question' }");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));
