import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { signRequest } from '@worldcoin/idkit-server';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const firstInstalled = (fallback: string, candidates: string[]) => candidates.find(existsSync) || fallback;
const agentCommands = {
  GPT: process.env.CODEX_BIN || firstInstalled('codex', ['/Applications/ChatGPT.app/Contents/Resources/codex']),
  Claude: process.env.CLAUDE_BIN || firstInstalled('claude', [join(homedir(), '.local/bin/claude')]),
  Gemini: process.env.GEMINI_BIN || 'gemini',
} as const;

type AgentName = 'GPT' | 'Claude' | 'Gemini';

async function connectionStatus() {
  const check = async (command: string, args: string[], match: RegExp) => {
    try {
      const { stdout, stderr } = await exec(command, args, { timeout: 5000 });
      return match.test(`${stdout}\n${stderr}`);
    } catch {
      return false;
    }
  };
  const [gpt, claude, gemini] = await Promise.all([
    check(agentCommands.GPT, ['login', 'status'], /Logged in/i),
    check(agentCommands.Claude, ['auth', 'status'], /"loggedIn"\s*:\s*true/i),
    check(agentCommands.Gemini, ['--version'], /\d/),
  ]);
  return { GPT: gpt, Claude: claude, Gemini: gemini };
}

function runAgent(provider: AgentName, prompt: string) {
  const system = 'You are a read-only finance workflow assistant inside an invoice liquidity dashboard. Answer concisely. Never execute commands, edit files, send transactions, or claim an action was completed. Explain any proposed workflow before action.';
  const command = agentCommands[provider];
  const args = provider === 'GPT'
    ? ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', projectRoot, `${system}\n\nUser request: ${prompt}`]
    : provider === 'Claude'
      ? ['-p', `${system}\n\nUser request: ${prompt}`, '--output-format', 'json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--allowedTools', 'Read,Glob,Grep']
      : ['-p', `${system}\n\nUser request: ${prompt}`];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env: process.env });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('The assistant took too long to respond.'));
    }, 120_000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 50_000) stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `${provider} exited with code ${code}`));
      if (provider === 'Claude') {
        try {
          const parsed = JSON.parse(stdout);
          return resolve(String(parsed.result ?? parsed.response ?? stdout).trim());
        } catch {
          return resolve(stdout.trim());
        }
      }
      resolve(stdout.trim());
    });
  });
}

function localAgentBridge() {
  return {
    name: 'local-agent-bridge',
    configureServer(server: any) {
      server.middlewares.use('/api/agents/status', async (_req: any, res: any) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(await connectionStatus()));
      });
      server.middlewares.use('/api/agents/chat', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('Method not allowed');
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += String(chunk);
          if (body.length > 32_000) req.destroy();
        });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const input = JSON.parse(body) as { provider?: AgentName; prompt?: string };
            if (!input.provider || !['GPT', 'Claude', 'Gemini'].includes(input.provider)) throw new Error('Choose a supported assistant.');
            if (!input.prompt?.trim()) throw new Error('Enter a message.');
            const status = await connectionStatus();
            if (!status[input.provider]) throw new Error(`${input.provider} is not connected on this machine.`);
            const reply = await runAgent(input.provider, input.prompt.trim());
            res.end(JSON.stringify({ reply }));
          } catch (error: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(error?.message ?? error) }));
          }
        });
      });
    },
  };
}

type WorldVerification = { address: string; score: number; verifiedAt: number; nullifier: string };
const WORLD_ACTION = 'consumer-invoice-advance';
const verificationPath = join(projectRoot, 'web', '.data', 'world-verifications.json');

async function readVerifications(): Promise<Record<string, WorldVerification>> {
  try {
    return JSON.parse(await readFile(verificationPath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveVerification(record: WorldVerification) {
  const records = await readVerifications();
  records[record.address.toLowerCase()] = record;
  await mkdir(dirname(verificationPath), { recursive: true });
  await writeFile(verificationPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function worldIdentityBridge(env: Record<string, string>) {
  const rpId = env.WORLD_RP_ID || process.env.WORLD_RP_ID || '';
  const signingKey = env.WORLD_RP_SIGNING_KEY || process.env.WORLD_RP_SIGNING_KEY || '';
  const configured = Boolean(env.VITE_WORLD_APP_ID && rpId && signingKey);
  const json = (res: any, status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  };
  const body = (req: any) => new Promise<any>((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += String(chunk);
      if (raw.length > 128_000) reject(new Error('Request is too large.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Body is not valid JSON.')); }
    });
  });
  return {
    name: 'world-identity-bridge',
    configureServer(server: any) {
      server.middlewares.use('/api/world/status', async (req: any, res: any) => {
        const address = new URL(req.url || '', 'http://localhost').searchParams.get('address') || '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(res, 400, { error: 'A valid wallet address is required.' });
        const records = await readVerifications();
        json(res, 200, { configured, verification: records[address.toLowerCase()] || null });
      });
      server.middlewares.use('/api/world/rp-context', async (req: any, res: any) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
          if (!configured) return json(res, 503, { error: 'World ID is not configured.' });
          const input = await body(req);
          if (input.action !== WORLD_ACTION) return json(res, 400, { error: 'Unsupported verification action.' });
          const signed = signRequest({ signingKeyHex: signingKey, action: WORLD_ACTION });
          json(res, 200, { rp_context: { rp_id: rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig } });
        } catch (error: any) {
          json(res, 400, { error: String(error?.message || error) });
        }
      });
      server.middlewares.use('/api/world/verify', async (req: any, res: any) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
          if (!configured) return json(res, 503, { error: 'World ID is not configured.' });
          const input = await body(req);
          if (!/^0x[0-9a-fA-F]{40}$/.test(input.address || '')) return json(res, 400, { error: 'A valid wallet address is required.' });
          const result = input.result;
          // Must match the `environment` prop on IDKitRequestWidget in consumer.tsx.
          if (result?.action !== WORLD_ACTION || result?.environment !== 'production') return json(res, 400, { error: 'Unexpected World ID action or environment.' });
          if (!result?.integrity_bundle) return json(res, 400, { error: 'Selfie Check integrity bundle is missing.' });
          const selfie = result?.responses?.find((item: any) => item.identifier === 'selfie');
          const score = Number(selfie?.sybil_score);
          if (!selfie?.nullifier || !Number.isFinite(score) || score < 0 || score > 100) return json(res, 400, { error: 'A valid Selfie Check Sybil score was not returned.' });
          if (selfie.signal_hash !== hashSignal(input.address)) return json(res, 400, { error: 'This Selfie Check is not bound to the connected wallet.' });
          const verified = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
          });
          const verification = await verified.json().catch(() => ({}));
          if (!verified.ok || !verification.success) return json(res, 400, { error: verification.detail || verification.code || 'World rejected this proof.' });
          const record = { address: input.address, score, verifiedAt: Math.floor(Date.now() / 1000), nullifier: selfie.nullifier };
          await saveVerification(record);
          json(res, 200, { verification: record });
        } catch (error: any) {
          json(res, 502, { error: String(error?.message || error) });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  return {
    plugins: [react(), localAgentBridge(), worldIdentityBridge(env)],
    // allowedHosts: true so the ngrok tunnel used for World ID Selfie Check (a free-tier subdomain that changes on
    // every restart) can reach the dev server; Vite otherwise rejects requests whose Host header it doesn't recognize.
    server: { host: '127.0.0.1', port: 5174, allowedHosts: true },
    // esbuild's dev-time dependency pre-bundler mishandles idkit-core's wasm-bindgen asset (idkit_wasm_bg.wasm comes
    // back as the SPA's index.html instead of the binary). Excluding just idkit-core makes Vite serve it straight
    // from node_modules, where the .wasm file is served correctly. `@worldcoin/idkit` itself stays bundled normally
    // so its CJS `qrcode` dependency still gets esbuild's CJS->ESM interop. `vite build` (Rollup) isn't affected.
    optimizeDeps: { exclude: ['@worldcoin/idkit-core'] },
  };
});
