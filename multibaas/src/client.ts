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
  risk: string;
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
  return { label, contractName: contract, version: versionOf(label), rawAbi: JSON.stringify(abi), bin };
}

/// ABI versions in the MultiBaas library. 2.0 = credit-priced registry + hardened market (2026-09-26).
export const versionOf = (label: string) => (label === LABELS.poolManager || label === LABELS.invoiceToken ? '1.0' : '2.0');

/// MultiBaas contract labels (ABI library) — also used as address aliases for singletons.
export const LABELS = {
  registry: 'tegata_invoice_registry',
  risk: 'tegata_credit_risk',
  hook: 'tegata_curve_hook',
  market: 'tegata_market',
  invoiceToken: 'tegata_invoice_token',
  poolManager: 'uniswap_v4_pool_manager',
} as const;

/// Address alias for invoice #id's token.
export const invoiceAlias = (id: number | bigint | string) => `tegata_invoice_${id}`;

/// Alias `address` and link it to `label` with event sync from `fromBlock`. After a redeploy the alias may still point
/// at a superseded contract: drop it and re-point it.
export async function linkAlias(alias: string, address: string, label: string, fromBlock: number) {
  const cfg = config();
  const addresses = new MultiBaas.AddressesApi(cfg);
  const contracts = new MultiBaas.ContractsApi(cfg);
  const current = await addresses.getAddress(alias).then((r) => r.data.result.address).catch(() => undefined);
  if (current && current.toLowerCase() !== address.toLowerCase()) {
    await addresses.deleteAddress(alias);
    console.log(`  ok   alias ${alias} moved off superseded ${current}`);
  }
  await idempotent(addresses.setAddress({ alias, address }), `alias ${alias} -> ${address}`);
  await idempotent(
    contracts.linkAddressContract(alias, { label, version: versionOf(label), startingBlock: String(fromBlock) }),
    `link+sync ${alias} (${label}) from ${fromBlock}`,
  );
}

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
