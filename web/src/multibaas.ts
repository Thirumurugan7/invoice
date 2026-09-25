// Optional: read the receivables book from MultiBaas Event Queries instead of RPC.
// Enable with VITE_MB_BASE_URL + VITE_MB_API_KEY (add this app's origin to the MultiBaas deployment's CORS list).
import * as MultiBaas from '@curvegrid/multibaas-sdk';

const base = import.meta.env.VITE_MB_BASE_URL as string | undefined;
const key = import.meta.env.VITE_MB_API_KEY as string | undefined;
export const multibaasEnabled = Boolean(base && key);

const api = () => new MultiBaas.EventQueriesApi(new MultiBaas.Configuration({ basePath: new URL('/api/v0', base!).toString(), accessToken: key! }));
const byAlias = (alias: string): MultiBaas.EventQueryFilter => ({ fieldType: 'contract_address_alias', operator: 'equal', value: alias });

export type MbBook = { registered: Record<string, any>[]; paid: Record<string, any>[]; trades: Record<string, any>[]; credit: Record<string, any>[] };

export async function fetchBookFromMultiBaas(): Promise<MbBook> {
  // MultiBaas returns at most 50 rows per request; page with offset.
  const q = async (query: MultiBaas.EventQuery, max = Infinity) => {
    const rows: Record<string, any>[] = [];
    for (let offset = 0; rows.length < max; offset += 50) {
      const page = ((await api().executeArbitraryEventQuery(query, offset, 50)).data.result?.rows ?? []) as Record<string, any>[];
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
