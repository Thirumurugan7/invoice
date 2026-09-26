// Vercel function: the AI operations desk runs the operator's local Claude Code, so the hosted site has no assistant.
export default function handler(_req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ hosted: true, GPT: false, Claude: false, Gemini: false });
}
