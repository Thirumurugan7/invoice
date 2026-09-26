import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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

/// GPT and Gemini: one-shot, non-streaming. Claude goes through streamClaude instead.
function runAgent(provider: Exclude<AgentName, 'Claude'>, prompt: string) {
  const system = 'You are a read-only finance workflow assistant inside an invoice liquidity dashboard. Answer concisely. Never execute commands, edit files, send transactions, or claim an action was completed. Explain any proposed workflow before action.';
  const command = agentCommands[provider];
  const args = provider === 'GPT'
    ? ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', projectRoot, `${system}\n\nUser request: ${prompt}`]
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
      resolve(stdout.trim());
    });
  });
}

// ---------------------------------------------------------------- Claude Code (streaming, sessions, live chain tools)
// Claude runs as the operator's own logged-in Claude Code, but boxed in: no built-in tools (no files, no shell), none of
// the user's other MCP servers or connectors, no project settings or CLAUDE.md, and an empty working directory. Its only
// tools are the read-only Tegata MCP server (web/agent/tegata-mcp.mjs), which reads the live contracts.
const opsDeskDir = join(tmpdir(), 'tegata-ops-desk'); // sessions are stored per working directory, so keep it fixed
const deploymentFile = join(projectRoot, 'web/public/deployment.json');
const OPS_DESK_PROMPT = [
  'You are the AI operations desk inside Tegata, an invoice-financing app: debtor-acknowledged invoices are tokenized and trade in JPYC on a Uniswap v4 pool whose hook keeps prices on a credit-priced discount curve.',
  'Use the tegata tools to read live on-chain data before answering questions about invoices, companies, collateral, rates or the market; never guess numbers. Cite invoice ids and amounts you read.',
  'You are read-only: you cannot send transactions, move funds or change anything. When an action is needed, say exactly which user should do what in the app (Supplier, Debtor, Investor or Operator tab).',
  'Company names are self-declared; only operator-rated companies are verified. Point this out when it matters for risk.',
  'Answer concisely for a finance operator. When the request asks for JSON only, return only that JSON.',
].join('\n');

function claudeArgs(prompt: string, sessionId: string | undefined, account: string | undefined) {
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  const rpc = deployment.chainId === 11155111 ? process.env.VITE_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com' : 'http://127.0.0.1:8546';
  const mcp = {
    mcpServers: {
      tegata: {
        command: process.execPath,
        args: [join(projectRoot, 'web/agent/tegata-mcp.mjs')],
        env: { TEGATA_DEPLOYMENT: deploymentFile, TEGATA_RPC_URL: rpc },
      },
    },
  };
  const context = account && /^0x[0-9a-fA-F]{40}$/.test(account) ? `\nThe operator's connected wallet is ${account}.` : '';
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--allowedTools', 'mcp__tegata',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--append-system-prompt', OPS_DESK_PROMPT + context,
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

const TOOL_LABELS: Record<string, string> = {
  mcp__tegata__get_overview: 'Reading the protocol overview',
  mcp__tegata__list_invoices: 'Reading invoices from the chain',
  mcp__tegata__get_invoice: 'Reading an invoice',
  mcp__tegata__get_company: 'Reading a company position',
};

/// Streams Claude Code to the browser as server-sent events: session, text (deltas), tool, done, error.
function streamClaude(req: any, res: any, prompt: string, sessionId: string | undefined, account: string | undefined) {
  mkdirSync(opsDeskDir, { recursive: true });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const child = spawn(agentCommands.Claude, claudeArgs(prompt, sessionId, account), { cwd: opsDeskDir, env: process.env });
  child.stdin.end();
  let buffer = '';
  let stderr = '';
  let finished = false;
  const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
  const finish = (event: string, data: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    send(event, data);
    res.end();
  };
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'init') send('session', { sessionId: msg.session_id, model: msg.model });
      else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') send('text', { delta: msg.event.delta.text });
      else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_start' && msg.event.content_block?.type === 'tool_use') {
        const name = String(msg.event.content_block.name);
        send('tool', { name, label: TOOL_LABELS[name] ?? `Using ${name}` });
      } else if (msg.type === 'result') {
        if (msg.is_error || msg.subtype !== 'success') finish('error', { error: String(msg.result || msg.subtype || 'Claude could not complete the request.'), sessionId: msg.session_id });
        else finish('done', { reply: String(msg.result ?? ''), sessionId: msg.session_id });
      }
    }
  });
  child.stderr.on('data', (chunk) => { if (stderr.length < 50_000) stderr += String(chunk); });
  child.on('error', (error) => finish('error', { error: error.message }));
  child.on('close', (code) => finish('error', { error: stderr.trim() || `Claude exited with code ${code} before finishing.` }));
  // Stop the agent if the browser goes away mid-answer.
  res.on('close', () => { if (!finished) child.kill('SIGTERM'); });
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
          if (body.length > 256_000) req.destroy(); // prompt + attachment (≤30k chars, multi-byte) + portfolio snapshot
        });
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const input = JSON.parse(body) as { provider?: AgentName; prompt?: string; sessionId?: string; account?: string };
            if (!input.provider || !['GPT', 'Claude', 'Gemini'].includes(input.provider)) throw new Error('Choose a supported assistant.');
            if (!input.prompt?.trim()) throw new Error('Enter a message.');
            const status = await connectionStatus();
            if (!status[input.provider]) throw new Error(`${input.provider} is not connected on this machine.`);
            if (input.provider === 'Claude') {
              const sessionId = input.sessionId && /^[0-9a-f-]{36}$/i.test(input.sessionId) ? input.sessionId : undefined;
              return streamClaude(req, res, input.prompt.trim(), sessionId, input.account);
            }
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

export default defineConfig({ plugins: [react(), localAgentBridge()], server: { host: '127.0.0.1', port: 5174 } });
