export function buildGraderPrompt(answerText) {
  return `You are an IGCSE examiner. Grade the following short student answer from 0 to 10, give constructive feedback, and mention the correct answer if needed.

Student Answer:
${answerText}`;
}
