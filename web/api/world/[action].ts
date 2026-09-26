// Vercel function: World ID Selfie Check (status, rp-context, verify). One function so the in-memory store is shared.
import { memoryStore, worldRpContext, worldStatus, worldVerify, type WorldEnv } from '../../server/world.js';

const store = memoryStore();
const env = (): WorldEnv => ({ appId: process.env.VITE_WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, signingKey: process.env.WORLD_RP_SIGNING_KEY });

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const action = String(req.query?.action ?? '');
    const reply =
      action === 'status' ? await worldStatus(env(), store, String(req.query?.address ?? ''))
        : req.method !== 'POST' ? { status: 405, body: { error: 'Method not allowed.' } }
          : action === 'rp-context' ? worldRpContext(env(), req.body)
            : action === 'verify' ? await worldVerify(env(), store, req.body)
              : { status: 404, body: { error: 'Unknown World ID action.' } };
    res.status(reply.status).json(reply.body);
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
}
