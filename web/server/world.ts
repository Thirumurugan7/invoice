// World ID Selfie Check, server side. Shared by the Vite dev server (vite.config.ts) and the Vercel functions (api/world).
// Each function returns { status, body } so both hosts can send it their own way.
import { signRequest } from '@worldcoin/idkit-server';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

export type WorldVerification = { address: string; score: number; verifiedAt: number; nullifier: string };
export type VerificationStore = {
  get(address: string): Promise<WorldVerification | undefined>;
  set(record: WorldVerification): Promise<void>;
};
export type WorldEnv = { appId?: string; rpId?: string; signingKey?: string };
type Reply = { status: number; body: unknown };

export const WORLD_ACTION = 'consumer-invoice-advance';
const isAddress = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const configured = (env: WorldEnv) => Boolean(env.appId && env.rpId && env.signingKey);

export async function worldStatus(env: WorldEnv, store: VerificationStore, address: string | null): Promise<Reply> {
  if (!isAddress(address)) return { status: 400, body: { error: 'A valid wallet address is required.' } };
  return { status: 200, body: { configured: configured(env), verification: (await store.get(address!)) ?? null } };
}

export function worldRpContext(env: WorldEnv, input: any): Reply {
  if (!configured(env)) return { status: 503, body: { error: 'World ID is not configured.' } };
  if (input?.action !== WORLD_ACTION) return { status: 400, body: { error: 'Unsupported verification action.' } };
  const signed = signRequest({ signingKeyHex: env.signingKey!, action: WORLD_ACTION });
  return {
    status: 200,
    body: { rp_context: { rp_id: env.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig } },
  };
}

export async function worldVerify(env: WorldEnv, store: VerificationStore, input: any): Promise<Reply> {
  if (!configured(env)) return { status: 503, body: { error: 'World ID is not configured.' } };
  if (!isAddress(input?.address)) return { status: 400, body: { error: 'A valid wallet address is required.' } };
  const result = input.result;
  // Must match the `environment` prop on IDKitRequestWidget in consumer.tsx.
  if (result?.action !== WORLD_ACTION || result?.environment !== 'production') return { status: 400, body: { error: 'Unexpected World ID action or environment.' } };
  if (!result?.integrity_bundle) return { status: 400, body: { error: 'Selfie Check integrity bundle is missing.' } };
  const selfie = result?.responses?.find((item: any) => item.identifier === 'selfie');
  const score = Number(selfie?.sybil_score);
  if (!selfie?.nullifier || !Number.isFinite(score) || score < 0 || score > 100) return { status: 400, body: { error: 'A valid Selfie Check Sybil score was not returned.' } };
  if (selfie.signal_hash !== hashSignal(input.address)) return { status: 400, body: { error: 'This Selfie Check is not bound to the connected wallet.' } };
  const verified = await fetch(`https://developer.world.org/api/v4/verify/${env.rpId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
  });
  const verification: any = await verified.json().catch(() => ({}));
  if (!verified.ok || !verification.success) return { status: 400, body: { error: verification.detail || verification.code || 'World rejected this proof.' } };
  const record = { address: input.address, score, verifiedAt: Math.floor(Date.now() / 1000), nullifier: selfie.nullifier };
  await store.set(record);
  return { status: 200, body: { verification: record } };
}

/// In-memory store (Vercel functions): verifications last as long as the function instance.
export function memoryStore(): VerificationStore {
  const records = new Map<string, WorldVerification>();
  return {
    get: async (address) => records.get(address.toLowerCase()),
    set: async (record) => void records.set(record.address.toLowerCase(), record),
  };
}
