import { createPublicClient, createWalletClient, custom, getAddress, http, zeroAddress, type Address, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';
import abis from './generated/abis.json';

export const ABI = abis as unknown as Record<'registry' | 'risk' | 'vault' | 'hook' | 'market' | 'token' | 'jpyc' | 'customRevert' | 'hooks', readonly unknown[]>;

export type Deployment = {
  chainId: number;
  startBlock: number;
  poolManager: Address;
  jpyc: Address;
  registry: Address;
  risk: Address;
  vault: Address;
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

/// Local anvil only: well-known anvil keys (public by design) so the local chain can be driven without a wallet.
/// On Sepolia every transaction is signed in the user's wallet (MetaMask, Rabby, ...) — no keys in the page.
export const DEV_ACCOUNTS = [
  { role: 'Operator', label: 'Operator / platform (#0)', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { role: 'Supplier', label: '下請 さくら精工 — supplier (#1)', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { role: 'Debtor', label: '東京モーターズ — debtor (#2)', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { role: 'Investor', label: 'Investor (#3)', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  // New companies: no name, unrated (priced as G5), funded with local JPYC by scripts/local-chain.sh.
  { role: 'Supplier', label: 'New company A — unrated (#4)', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
  { role: 'Debtor', label: 'New company B — unrated (#5)', key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' },
] as const;

export type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<any>; on?: (e: string, f: (...a: any[]) => void) => void; removeListener?: (e: string, f: (...a: any[]) => void) => void };

/// `wallet` is absent in read-only mode (nothing connected yet). Reads always go over HTTP RPC so the app works
/// before a wallet connects and regardless of which RPC the wallet uses.
export type Session = { account: Address; wallet?: WalletClient; pub: PublicClient; provider?: Eip1193; kind: 'local' | 'wallet' | 'readonly' };

const SEPOLIA_RPC = (import.meta.env.VITE_SEPOLIA_RPC as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const chainOf = (chainId: number) => (chainId === sepolia.id ? { chain: sepolia, rpc: SEPOLIA_RPC } : { chain: localChain, rpc: LOCAL_RPC });
const readClient = (chainId: number) => {
  const { chain, rpc } = chainOf(chainId);
  return createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
};

export function readonlySession(chainId: number): Session {
  return { account: zeroAddress, pub: readClient(chainId), kind: 'readonly' };
}

export function devSession(key: `0x${string}`, chainId = 31337): Session {
  const account = privateKeyToAccount(key);
  const { chain, rpc } = chainOf(chainId);
  return { account: account.address, wallet: createWalletClient({ account, chain, transport: http(rpc) }), pub: readClient(chainId), kind: 'local' };
}

// ---------------------------------------------------------------- browser wallets (EIP-6963 + window.ethereum)
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string; provider: Eip1193 };

/// Discover installed wallets via EIP-6963 (falls back to window.ethereum). Calls `onChange` with the full list.
export function discoverWallets(onChange: (w: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>();
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (!d?.info?.uuid || found.has(d.info.rdns)) return;
    found.set(d.info.rdns, { ...d.info, provider: d.provider });
    onChange([...found.values()]);
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const t = setTimeout(() => {
    const eth = (window as any).ethereum;
    if (found.size === 0 && eth) onChange([{ uuid: 'injected', name: eth.isBraveWallet ? 'Brave Wallet' : eth.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '', rdns: 'injected', provider: eth }]);
  }, 400);
  return () => {
    clearTimeout(t);
    window.removeEventListener('eip6963:announceProvider', onAnnounce);
  };
}

/// Make sure the wallet is on the deployment's chain: switch, or add Sepolia if the wallet doesn't know it.
export async function ensureChain(provider: Eip1193, chainId: number) {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === chainId) return;
  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    const { chain, rpc } = chainOf(chainId);
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [rpc], blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [] }],
    });
  }
}

export async function walletChainId(provider: Eip1193): Promise<number> {
  return Number(await provider.request({ method: 'eth_chainId' }));
}

/// Session for an account the user approved in their wallet. `request` = true prompts the wallet (connect button);
/// false only restores an already-authorized account (page reload).
export async function walletSession(provider: Eip1193, chainId: number, request = true): Promise<Session | undefined> {
  const accounts = (await provider.request({ method: request ? 'eth_requestAccounts' : 'eth_accounts' })) as Address[];
  if (!accounts?.length) return undefined;
  if (request) await ensureChain(provider, chainId);
  return sessionFor(provider, getAddress(accounts[0]), chainId);
}

export function sessionFor(provider: Eip1193, account: Address, chainId: number): Session {
  const { chain } = chainOf(chainId);
  return { account, wallet: createWalletClient({ account, chain, transport: custom(provider) }), pub: readClient(chainId), provider, kind: 'wallet' };
}

export const explorerTx = (chainId: number, hash: string) => (chainId === sepolia.id ? `https://sepolia.etherscan.io/tx/${hash}` : undefined);
export const explorerAddress = (chainId: number, a: string) => (chainId === sepolia.id ? `https://sepolia.etherscan.io/address/${a}` : undefined);

/// JPYC Inc.'s official Sepolia faucet: sendToken(to, amount) — ≤3,000,000 JPYC per claim, once per 24h, only while
/// the recipient holds ≤1,000,000 JPYC.
export const JPYC_FAUCET = { address: '0x5Fe7943a7823f6837756e9F0f259cd93494cc5D5' as Address, claim: 3_000_000n * 10n ** 18n };
export const FAUCET_ABI = [
  { type: 'function', name: 'sendToken', stateMutability: 'nonpayable', inputs: [{ name: '_to', type: 'address' }, { name: '_amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'lastAccessTime', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

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
