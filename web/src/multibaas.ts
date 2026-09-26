// Read the receivables book from MultiBaas Event Queries through this app's own server (/api/mb/query: the Vite dev
// server locally, a Vercel function when hosted). The MultiBaas API key stays on the server and never ships to the browser.
import type * as MultiBaas from '@curvegrid/multibaas-sdk';

export const multibaasEnabled = true;

export async function runEventQuery(query: MultiBaas.EventQuery, offset: number, limit: number): Promise<Record<string, any>[]> {
  const response = await fetch('/api/mb/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, offset, limit }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `MultiBaas query failed (${response.status})`);
  return (body.result?.rows ?? []) as Record<string, any>[];
}

const byAlias = (alias: string): MultiBaas.EventQueryFilter => ({ fieldType: 'contract_address_alias', operator: 'equal', value: alias });

export type MbBook = { registered: Record<string, any>[]; paid: Record<string, any>[]; trades: Record<string, any>[]; credit: Record<string, any>[] };

export async function fetchBookFromMultiBaas(): Promise<MbBook> {
  // MultiBaas returns at most 50 rows per request; page with offset.
  const q = async (query: MultiBaas.EventQuery, max = Infinity) => {
    const rows: Record<string, any>[] = [];
    for (let offset = 0; rows.length < max; offset += 50) {
      const page = await runEventQuery(query, offset, 50);
      rows.push(...page);
      if (page.length < 50) break;
    }
    return rows.slice(0, max);
  };
  const [registered, paid, trades, credit] = await Promise.all([
    q({
      events: [
        {
          eventName: 'InvoiceRegistered',
          select: [
            { type: 'input', inputIndex: 0, alias: 'id' },
            { type: 'input', inputIndex: 2, alias: 'debtor' },
            { type: 'input', inputIndex: 4, alias: 'face' },
            { type: 'input', inputIndex: 5, alias: 'maturity' },
          ],
          filter: byAlias('tegata_invoice_registry'),
        },
      ],
    }),
    q({
      events: [{ eventName: 'InvoicePaid', select: [{ type: 'input', inputIndex: 0, alias: 'id' }, { type: 'input', inputIndex: 2, alias: 'paid', aggregator: 'add' }], filter: byAlias('tegata_invoice_registry') }],
      groupBy: 'id',
    }),
    q(
      {
        events: [
          {
            eventName: 'CurveTrade',
            select: [
              { type: 'input', inputIndex: 0, alias: 'id' },
              { type: 'input', inputIndex: 2, alias: 'price' },
              { type: 'input', inputIndex: 3, alias: 'fair' },
              { type: 'triggered_at', alias: 'at' },
            ],
            filter: byAlias('tegata_curve_hook'),
          },
        ],
        orderBy: 'at',
        order: 'DESC',
      },
      20,
    ),
    q(
      {
        events: [
          {
            eventName: 'DebtorRated',
            select: [
              { type: 'input', inputIndex: 0, alias: 'debtor' },
              { type: 'input', inputIndex: 1, alias: 'grade' },
              { type: 'input', inputIndex: 2, alias: 'rate_bps' },
              { type: 'triggered_at', alias: 'at' },
            ],
            filter: byAlias('tegata_credit_risk'),
          },
          {
            eventName: 'CreditEventRecorded',
            select: [
              { type: 'input', inputIndex: 0, alias: 'debtor' },
              { type: 'input', inputIndex: 1, alias: 'kind' },
              { type: 'input', inputIndex: 3, alias: 'rate_bps' },
              { type: 'triggered_at', alias: 'at' },
            ],
            filter: byAlias('tegata_credit_risk'),
          },
        ],
        orderBy: 'at',
        order: 'DESC',
      },
      20,
    ),
  ]);
  return { registered, paid, trades, credit };
}
