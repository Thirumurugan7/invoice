// Receivables book from MultiBaas Event Queries (indexed chain data, no RPC scanning).
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { config, LABELS } from './client.ts';

const api = new MultiBaas.EventQueriesApi(config());
const byAlias = (alias: string): MultiBaas.EventQueryFilter => ({ fieldType: 'contract_address_alias', operator: 'equal', value: alias });
/// MultiBaas Event Queries return at most 50 rows per request (51+ -> 400 "invalid request"), so page with offset.
const PAGE = 50;
const run = async (q: MultiBaas.EventQuery, max = Infinity) => {
  const rows: Record<string, any>[] = [];
  for (let offset = 0; rows.length < max; offset += PAGE) {
    const page = ((await api.executeArbitraryEventQuery(q, offset, PAGE)).data.result?.rows ?? []) as Record<string, any>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows.slice(0, max);
};

/// Every invoice ever registered (id, parties, face, maturity, debtor's rate at registration).
export const registeredQuery: MultiBaas.EventQuery = {
  events: [
    {
      eventName: 'InvoiceRegistered',
      select: [
        { type: 'input', inputIndex: 0, alias: 'id' },
        { type: 'input', inputIndex: 1, alias: 'supplier' },
        { type: 'input', inputIndex: 2, alias: 'debtor' },
        { type: 'input', inputIndex: 4, alias: 'face' },
        { type: 'input', inputIndex: 5, alias: 'maturity' },
        { type: 'input', inputIndex: 6, alias: 'rate_at_issue_bps' },
      ],
      filter: byAlias(LABELS.registry),
    },
  ],
};

/// Invoice reference numbers and party names (RWA metadata).
export const metadataQuery: MultiBaas.EventQuery = {
  events: [
    {
      eventName: 'InvoiceMetadata',
      select: [
        { type: 'input', inputIndex: 0, alias: 'id' },
        { type: 'input', inputIndex: 1, alias: 'ref' },
      ],
      filter: byAlias(LABELS.registry),
    },
  ],
};

/// JPYC paid in per invoice (aggregated).
export const paidQuery: MultiBaas.EventQuery = {
  events: [
    {
      eventName: 'InvoicePaid',
      select: [
        { type: 'input', inputIndex: 0, alias: 'id' },
        { type: 'input', inputIndex: 2, alias: 'paid', aggregator: 'add' },
      ],
      filter: byAlias(LABELS.registry),
    },
  ],
  groupBy: 'id',
};

/// Invoices the debtor disputed before acceptance: never a claim, so never outstanding.
export const rejectedQuery: MultiBaas.EventQuery = {
  events: [{ eventName: 'InvoiceRejected', select: [{ type: 'input', inputIndex: 0, alias: 'id' }], filter: byAlias(LABELS.registry) }],
};

/// Uniswap trades enforced by the curve hook.
export const tradesQuery: MultiBaas.EventQuery = {
  events: [
    {
      eventName: 'CurveTrade',
      select: [
        { type: 'input', inputIndex: 0, alias: 'id' },
        { type: 'input', inputIndex: 2, alias: 'price' },
        { type: 'input', inputIndex: 3, alias: 'fair' },
        { type: 'input', inputIndex: 4, alias: 'deviation_bps' },
        { type: 'triggered_at', alias: 'at' },
      ],
      filter: byAlias(LABELS.hook),
    },
  ],
  orderBy: 'at',
  order: 'DESC',
};

/// Credit history: operator ratings and registry-recorded settlements/defaults (each reprices the debtor's invoices).
export const creditQuery: MultiBaas.EventQuery = {
    events: [
      {
        eventName: 'DebtorRated',
        select: [
          { type: 'input', inputIndex: 0, alias: 'debtor' },
          { type: 'input', inputIndex: 1, alias: 'grade' },
          { type: 'input', inputIndex: 2, alias: 'rate_bps' },
          { type: 'triggered_at', alias: 'at' },
        ],
        filter: byAlias(LABELS.risk),
      },
      {
        eventName: 'CreditEventRecorded',
        select: [
          { type: 'input', inputIndex: 0, alias: 'debtor' },
          { type: 'input', inputIndex: 1, alias: 'kind' },
          { type: 'input', inputIndex: 3, alias: 'rate_bps' },
          { type: 'triggered_at', alias: 'at' },
        ],
        filter: byAlias(LABELS.risk),
      },
    ],
    orderBy: 'at',
    order: 'DESC',
  };

const yen = (wei: string | number) => `¥${(Number(BigInt(String(wei)) / 10n ** 16n) / 100).toLocaleString('ja-JP')}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [invoices, paid, trades, rejected, credit] = await Promise.all([
    run(registeredQuery),
    run(paidQuery),
    run(tradesQuery, 20),
    run(rejectedQuery),
    run(creditQuery, 20),
  ]);
  const refById = new Map((await run(metadataQuery)).map((r) => [String(r.id), String(r.ref)]));
  const rejectedIds = new Set(rejected.map((r) => String(r.id)));
  const paidById = new Map(paid.map((r) => [String(r.id), String(r.paid)]));
  console.log('Receivables book (MultiBaas Event Queries)\n');
  const byDebtor = new Map<string, bigint>();
  for (const r of invoices) {
    const isRejected = rejectedIds.has(String(r.id));
    const outstanding = isRejected ? 0n : BigInt(String(r.face)) - BigInt(paidById.get(String(r.id)) ?? '0');
    byDebtor.set(String(r.debtor), (byDebtor.get(String(r.debtor)) ?? 0n) + outstanding);
    const due = new Date(Number(r.maturity) * 1000).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`#${r.id} ${refById.get(String(r.id)) ?? ''}  face ${yen(String(r.face))}  due ${due}  rate@issue ${Number(r.rate_at_issue_bps) / 100}%  outstanding ${yen(outstanding.toString())}${isRejected ? '  (rejected)' : ''}`);
  }
  console.log('\nOutstanding by debtor:');
  for (const [debtor, amt] of byDebtor) console.log(`  ${debtor}  ${yen(amt.toString())}`);
  const KIND = ['on-time settlement', 'late payment', 'DEFAULT'];
  console.log(`\nCredit events (latest ${credit.length}):`);
  for (const c of credit) {
    const what = c.grade !== undefined && c.grade !== null ? `rated G${c.grade}` : KIND[Number(c.kind)];
    console.log(`  ${c.debtor}  ${what}  -> rate ${Number(c.rate_bps) / 100}%  ${c.at}`);
  }
  console.log(`\nLatest curve trades: ${trades.length}`);
  for (const t of trades) console.log(`  #${t.id}  price ${Number(BigInt(String(t.price))) / 1e18}  fair ${Number(BigInt(String(t.fair))) / 1e18}  dev ${t.deviation_bps}bps  ${t.at}`);
}
