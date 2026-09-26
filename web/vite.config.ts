import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

export default defineConfig({ plugins: [react(), localAgentBridge()], server: { host: '127.0.0.1', port: 5174 } });
