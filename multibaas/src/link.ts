// Registers Tegata in MultiBaas: ABI library, address aliases, event sync from the deployment block, one alias per
// existing invoice token (backfill), and the event.emitted webhook. Safe to re-run.
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseContract, config, deployment, idempotent, invoiceAlias, LABELS, linkAlias } from './client.ts';

const cfg = config();
const contracts = new MultiBaas.ContractsApi(cfg);
const chains = new MultiBaas.ChainsApi(cfg);
const webhooks = new MultiBaas.WebhooksApi(cfg);
const d = deployment();

const status = (await chains.getChainStatus()).data.result;
console.log(`MultiBaas chain ${status.chainID} @ block ${status.blockNumber}`);
if (status.chainID !== d.chainId) throw new Error(`deployment chain ${d.chainId} != MultiBaas chain ${status.chainID}`);

// 1. ABI library
for (const [label, name] of [
  [LABELS.registry, 'InvoiceRegistry'],
  [LABELS.risk, 'CreditRiskModel'],
  [LABELS.vault, 'CollateralVault'],
  [LABELS.hook, 'MaturityCurveHook'],
  [LABELS.market, 'TegataMarket'],
  [LABELS.invoiceToken, 'InvoiceToken'],
  [LABELS.poolManager, 'PoolManager'],
] as const) {
  await idempotent(contracts.createContract(label, baseContract(label, name)), `abi ${label}`);
}

// 2. Singletons: alias + link + sync events from the deployment block
const link = linkAlias;
await link(LABELS.registry, d.registry, LABELS.registry, d.startBlock);
await link(LABELS.risk, d.risk, LABELS.risk, d.startBlock);
await link(LABELS.vault, d.vault, LABELS.vault, d.startBlock);
await link(LABELS.hook, d.hook, LABELS.hook, d.startBlock);
// The market can be redeployed on its own (see README); index it from its own creation block when recorded.
await link(LABELS.market, d.market, LABELS.market, (d as any).marketStartBlock ?? d.startBlock);
// The PoolManager is shared by every v4 pool on the chain: sync only from our deployment block.
await link(LABELS.poolManager, d.poolManager, LABELS.poolManager, d.startBlock);

// 3. Backfill invoice tokens already registered (new ones are linked live by webhook-server.ts)
// Each token is synced from the block its invoice was registered in (the token is created there), which also keeps
// the sync inside the MultiBaas plan's past-logs depth limit.
const SYNC_DEPTH = Number(process.env.MB_SYNC_DEPTH ?? 100);
const registeredAt = new Map<string, number>();
for (let offset = 0; ; offset += 50) {
  const q = { events: [{ eventName: 'InvoiceRegistered', select: [{ type: 'input', inputIndex: 0, alias: 'id' }, { type: 'block_number', alias: 'block' }], filter: { fieldType: 'contract_address_alias', operator: 'equal', value: LABELS.registry } }] };
  const rows = ((await new MultiBaas.EventQueriesApi(cfg).executeArbitraryEventQuery(q as any, offset, 50)).data.result?.rows ?? []) as Record<string, any>[];
  for (const r of rows) registeredAt.set(String(r.id), Number(r.block));
  if (rows.length < 50) break;
}
const count = await contracts.callContractFunction(LABELS.registry, LABELS.registry, 'invoiceCount', { args: [] });
const n = Number((count.data.result as any).output ?? 0);
for (let id = 1; id <= n; id++) {
  const inv = await contracts.callContractFunction(LABELS.registry, LABELS.registry, 'invoice', { args: [String(id)] });
  const token = (inv.data.result as any).output?.token ?? (inv.data.result as any).output?.[2];
  // The free plan only syncs very recent history; older tokens are indexed from the edge of that window.
  const from = Math.max(registeredAt.get(String(id)) ?? d.startBlock, Number(status.blockNumber) - SYNC_DEPTH);
  // The plan also caps linked contracts; warn and keep going rather than abort the whole run.
  if (token) await link(invoiceAlias(id), token, LABELS.invoiceToken, from).catch((e: Error) => console.log(`  warn ${invoiceAlias(id)}: ${e.message}`));
}

// 4. Webhook for live automation
if (process.env.WEBHOOK_URL) {
  try {
    const res = await webhooks.createWebhook({ url: process.env.WEBHOOK_URL, label: 'tegata_events', subscriptions: ['event.emitted'] });
    const secret = (res.data.result as any)?.secret as string | undefined;
    console.log(`  ok   webhook -> ${process.env.WEBHOOK_URL}`);
    if (secret) {
      // Persist the signing secret for webhook-server.ts (multibaas/.env is gitignored).
      const envPath = resolve(import.meta.dirname, '../.env');
      const env = readFileSync(envPath, 'utf8').split('\n').filter((l) => !l.startsWith('WEBHOOK_SECRET='));
      writeFileSync(envPath, [...env.filter(Boolean), `WEBHOOK_SECRET=${secret}`].join('\n') + '\n', { mode: 0o600 });
      console.log('  ok   webhook signing secret saved to multibaas/.env');
    }
  } catch (e: any) {
    if (e?.response?.status === 409) console.log('  skip webhook (exists)');
    else throw e;
  }
}
console.log('Done. Run `npm run webhook` (receiver) and `npm run book` (Event Queries).');
