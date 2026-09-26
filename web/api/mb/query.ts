// Vercel function: read-only MultiBaas Event Queries for the receivables book. The API key never reaches the browser.
import { multibaasQuery } from '../../server/multibaas.js';

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const reply = await multibaasQuery({ baseUrl: process.env.MB_BASE_URL, apiKey: process.env.MB_API_KEY }, req.body);
    res.status(reply.status).json(reply.body);
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
}
