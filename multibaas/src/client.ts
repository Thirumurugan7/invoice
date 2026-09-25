import * as MultiBaas from '@curvegrid/multibaas-sdk';
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

export function config(): MultiBaas.Configuration {
  const base = process.env.MB_BASE_URL;
  const key = process.env.MB_API_KEY;
  if (!base || !key) throw new Error('Set MB_BASE_URL and MB_API_KEY in multibaas/.env (see .env.example)');
  return new MultiBaas.Configuration({ basePath: new URL('/api/v0', base).toString(), accessToken: key });
}

export type Deployment = {
  chainId: number;
  startBlock: number;
  poolManager: string;
  jpyc: string;
  registry: string;
  hook: string;
  market: string;
  operator: string;
};

export function deployment(): Deployment {
  const chainId = process.env.CHAIN_ID ?? '11155111';
  return JSON.parse(readFileSync(resolve(ROOT, `deployments/${chainId}.json`), 'utf8'));
}

export function forgeAbi(contract: string): string {
  return JSON.stringify(forgeArtifact(contract).abi);
}

/// MultiBaas requires the creation bytecode (`bin`) when registering a contract, not just the ABI.
export function forgeArtifact(contract: string): { abi: unknown[]; bin: string } {
  const artifact = JSON.parse(readFileSync(resolve(ROOT, `out/${contract}.sol/${contract}.json`), 'utf8'));
  return { abi: artifact.abi, bin: artifact.bytecode?.object ?? artifact.bytecode };
}

/// BaseContract payload for ContractsApi.createContract.
export function baseContract(label: string, contract: string) {
  const { abi, bin } = forgeArtifact(contract);
  return { label, contractName: contract, version: '1.0', rawAbi: JSON.stringify(abi), bin };
}

/// MultiBaas contract labels (ABI library) — also used as address aliases for singletons.
export const LABELS = {
  registry: 'tegata_invoice_registry',
  hook: 'tegata_curve_hook',
  market: 'tegata_market',
  invoiceToken: 'tegata_invoice_token',
  poolManager: 'uniswap_v4_pool_manager',
} as const;

/// Address alias for invoice #id's token.
export const invoiceAlias = (id: number | bigint | string) => `tegata_invoice_${id}`;

/// 409 = already exists -> treat as success so scripts are re-runnable.
export async function idempotent<T>(p: Promise<T>, what: string): Promise<void> {
  try {
    await p;
    console.log(`  ok   ${what}`);
  } catch (e: any) {
    if (e?.response?.status === 409) console.log(`  skip ${what} (exists)`);
    else throw new Error(`${what}: ${e?.response?.status ?? ''} ${JSON.stringify(e?.response?.data ?? e?.message)}`);
  }
}
