// index.js
const { App } = require('@slack/bolt');
const OpenAI = require('openai');
const pdf = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const axios = require('axios');
const fs = require('fs');

// Initialize Slack Bolt app with bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Helper: call OpenAI to solve a question
async function solveWithOpenAI(question) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: question }]
  });
  return resp.choices[0].message.content;
}

// Main handler for app mentions
app.event('app_mention', async ({ event, client }) => {
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  try {
    // Remove bot mention from text
    let text = (event.text || '').replace(/<@[^>]+>/, '').trim();

    // If no attachments, treat as text question
    if (!event.files || event.files.length === 0) {
      if (!text) {
        // Empty mention
        await client.chat.postMessage({ channel, thread_ts, text: "Please ask a question or attach a file." });
        return;
      }
      // Call OpenAI for answer
      const answer = await solveWithOpenAI(text);
      // Reply in thread
      await client.chat.postMessage({ channel, thread_ts, text: answer });
      return;
    }

    // Process attachments (PDF or image)
    for (const file of event.files) {
      const url = file.url_private_download || file.url_private;
      const mime = file.mimetype || '';
      let extractedText = '';

      // Download the file from Slack
      const fileResp = await axios.get(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        responseType: 'arraybuffer'
      });

      if (file.filetype === 'pdf') {
        // PDF: extract text via pdf-parse:contentReference[oaicite:9]{index=9}
        const data = await pdf(fileResp.data);
        extractedText = data.text;
      } else if (mime.startsWith('image/')) {
        // Image: do OCR via Tesseract.js:contentReference[oaicite:10]{index=10}:contentReference[oaicite:11]{index=11}
        const buffer = Buffer.from(fileResp.data);
        const ocrResult = await Tesseract.recognize(buffer, 'eng');
        extractedText = ocrResult.data.text;
      } else {
        // Unsupported file
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Sorry, I can’t process files of type \`${file.filetype}\`. Please send a text, PDF, or image.`
        });
        continue;
      }

      // Use OpenAI to solve the extracted text
      const solution = await solveWithOpenAI(extractedText);

      // Create a PDF with the solution using pdf-lib:contentReference[oaicite:12]{index=12}
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage();
      const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 12;
      const { width, height } = page.getSize();
      page.setFont(helveticaFont);
      page.setFontSize(fontSize);
      page.setTextColor(rgb(0, 0, 0));
      // Split solution into lines
      const lines = solution.split('\n');
      let y = height - 50;
      for (const line of lines) {
        page.drawText(line, { x: 50, y });
        y -= fontSize + 4;
        // Add new page if needed
        if (y < 50) {
          y = height - 50;
          page = pdfDoc.addPage();
          page.setFont(helveticaFont);
          page.setFontSize(fontSize);
        }
      }
      const pdfBytes = await pdfDoc.save();
      // Write to temp file
      const outPath = `/tmp/solution_${file.id}.pdf`;
      fs.writeFileSync(outPath, pdfBytes);

      // Upload the solved PDF back to Slack in the same thread:contentReference[oaicite:13]{index=13}:contentReference[oaicite:14]{index=14}
      await client.files.uploadV2({
        initial_comment: "Here is the solved worksheet:",
        thread_ts,
        file: fs.createReadStream(outPath),
        filename: file.name ? `solution_${file.name}` : 'solution.pdf',
        title: file.name ? `Solved ${file.name}` : 'Solution'
      });

      // Optionally, delete temp file
      fs.unlinkSync(outPath);
    }
  } catch (err) {
    console.error('Error handling app_mention:', err);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `❗️ An error occurred: ${err.message}`
    });
  }
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Axon AI Slack bot is running!');
})();
