import { createPublicClient, createWalletClient, custom, http, type Address, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';
import abis from './generated/abis.json';

export const ABI = abis as unknown as Record<'registry' | 'hook' | 'market' | 'token' | 'jpyc' | 'customRevert' | 'hooks', readonly unknown[]>;

export type Deployment = {
  chainId: number;
  startBlock: number;
  poolManager: Address;
  jpyc: Address;
  registry: Address;
  hook: Address;
  market: Address;
  operator: Address;
};

export async function loadDeployment(): Promise<Deployment> {
  const res = await fetch('/deployment.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No deployment.json — run scripts/local-chain.sh');
  return res.json();
}

const LOCAL_RPC = 'http://127.0.0.1:8546';
const localChain: Chain = { ...foundry, rpcUrls: { default: { http: [LOCAL_RPC] } } };

/// Demo accounts. Anvil well-known keys by default; for a testnet demo, VITE_DEMO_KEYS (comma-separated:
/// operator,supplier,debtor,investor — throwaway testnet keys in web/.env.local, never commit) overrides them.
const ANVIL_ACCOUNTS = [
  { role: 'Operator', label: 'Operator / platform (#0)', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { role: 'Supplier', label: '下請 さくら精工 — supplier (#1)', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { role: 'Debtor', label: '東京モーターズ — debtor (#2)', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { role: 'Investor', label: 'Investor (#3)', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
] as const;

const demoKeys = ((import.meta.env.VITE_DEMO_KEYS as string | undefined) ?? '').split(',').map((k) => k.trim()).filter(Boolean);
export const DEV_ACCOUNTS = ANVIL_ACCOUNTS.map((a, i) => ({ ...a, key: (demoKeys[i] ?? a.key) as `0x${string}` }));
export const hasDemoKeys = demoKeys.length === 4;

export type Session = { account: Address; wallet: WalletClient; pub: PublicClient };

const SEPOLIA_RPC = (import.meta.env.VITE_SEPOLIA_RPC as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';

export function devSession(key: `0x${string}`, chainId = 31337): Session {
  const account = privateKeyToAccount(key);
  const [chain, rpc] = chainId === sepolia.id ? [sepolia, SEPOLIA_RPC] : [localChain, LOCAL_RPC];
  return {
    account: account.address,
    wallet: createWalletClient({ account, chain, transport: http(rpc) }),
    pub: createPublicClient({ chain, transport: http(rpc) }) as PublicClient,
  };
}

export async function injectedSession(chainId: number): Promise<Session> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No injected wallet found');
  const chain = chainId === sepolia.id ? sepolia : localChain;
  const [account] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: custom(eth) }),
    pub: createPublicClient({ chain, transport: custom(eth) }) as PublicClient,
  };
}

export async function warpDays(days: number) {
  const call = (method: string, params: unknown[]) =>
    fetch(LOCAL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  const b = await call('eth_getBlockByNumber', ['latest', false]);
  await call('evm_setNextBlockTimestamp', [Number(BigInt(b.result.timestamp)) + days * 86400]);
  await call('evm_mine', []);
}

/// SHA-256 of an uploaded invoice file -> bytes32 docHash (the duplicate-financing key).
export async function sha256File(file: File): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return ('0x' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}
