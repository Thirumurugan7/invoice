// Event explorer: every event the Tegata contracts emit, read from Curvegrid MultiBaas Event Queries (indexed chain
// data, no RPC log scanning). Queries go through this app's /api/mb/query proxy, so the MultiBaas key stays server-side.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { jst, price, short, yen } from './errors';
import { runEventQuery } from './multibaas';

type Kind = 'id' | 'addr' | 'yen' | 'price' | 'bps' | 'time' | 'grade' | 'credit' | 'bool' | 'hash' | 'text' | 'num';
type Spec = { contract: ContractKey; name: string; fields: [string, Kind][] };
type ContractKey = 'registry' | 'risk' | 'vault' | 'hook' | 'market' | 'token';
type Row = { spec: Spec; at: number; block: number; tx: string; alias: string; values: Record<string, string> };

/// MultiBaas address aliases set by multibaas/src/link.ts; invoice tokens share the tegata_invoice_token label.
const CONTRACTS: Record<ContractKey, { label: string; alias: string; filter: 'contract_address_alias' | 'contract_label' }> = {
  registry: { label: 'Invoice registry', alias: 'tegata_invoice_registry', filter: 'contract_address_alias' },
  risk: { label: 'Credit risk model', alias: 'tegata_credit_risk', filter: 'contract_address_alias' },
  vault: { label: 'Collateral vault', alias: 'tegata_collateral_vault', filter: 'contract_address_alias' },
  hook: { label: 'Uniswap v4 curve hook', alias: 'tegata_curve_hook', filter: 'contract_address_alias' },
  market: { label: 'Market router', alias: 'tegata_market', filter: 'contract_address_alias' },
  token: { label: 'Invoice tokens', alias: 'tegata_invoice_token', filter: 'contract_label' },
};

const EVENTS: Spec[] = [
  { contract: 'registry', name: 'InvoiceRegistered', fields: [['id', 'id'], ['supplier', 'addr'], ['debtor', 'addr'], ['token', 'addr'], ['face', 'yen'], ['maturity', 'time'], ['rateAtIssueBps', 'bps'], ['docHash', 'hash']] },
  { contract: 'registry', name: 'InvoiceMetadata', fields: [['id', 'id'], ['ref', 'text'], ['supplierName', 'text'], ['debtorName', 'text']] },
  { contract: 'registry', name: 'InvoiceAccepted', fields: [['id', 'id'], ['debtor', 'addr'], ['token', 'addr'], ['face', 'yen']] },
  { contract: 'registry', name: 'InvoiceRejected', fields: [['id', 'id'], ['debtor', 'addr'], ['reason', 'text']] },
  { contract: 'registry', name: 'InvoicePaid', fields: [['id', 'id'], ['payer', 'addr'], ['amount', 'yen'], ['funded', 'yen']] },
  { contract: 'registry', name: 'InvoiceSettled', fields: [['id', 'id'], ['funded', 'yen']] },
  { contract: 'registry', name: 'InvoiceDefaulted', fields: [['id', 'id'], ['funded', 'yen'], ['face', 'yen']] },
  { contract: 'registry', name: 'InvoiceFrozen', fields: [['id', 'id'], ['frozen', 'bool']] },
  { contract: 'registry', name: 'Redeemed', fields: [['id', 'id'], ['holder', 'addr'], ['tokens', 'yen'], ['jpycPaid', 'yen']] },
  { contract: 'registry', name: 'CompanyNamed', fields: [['company', 'addr'], ['name', 'text']] },
  { contract: 'registry', name: 'RoleGranted', fields: [['role', 'hash'], ['account', 'addr'], ['sender', 'addr']] },
  { contract: 'registry', name: 'RoleRevoked', fields: [['role', 'hash'], ['account', 'addr'], ['sender', 'addr']] },
  { contract: 'risk', name: 'DebtorRated', fields: [['debtor', 'addr'], ['grade', 'grade'], ['rateBps', 'bps']] },
  { contract: 'risk', name: 'CreditEventRecorded', fields: [['debtor', 'addr'], ['kind', 'credit'], ['invoiceId', 'id'], ['rateBps', 'bps']] },
  { contract: 'risk', name: 'BaseRateSet', fields: [['bps', 'bps']] },
  { contract: 'risk', name: 'GradeSpreadSet', fields: [['grade', 'grade'], ['bps', 'bps']] },
  { contract: 'risk', name: 'RegistrySet', fields: [['registry', 'addr']] },
  { contract: 'risk', name: 'VaultSet', fields: [['vault', 'addr']] },
  { contract: 'risk', name: 'RoleGranted', fields: [['role', 'hash'], ['account', 'addr'], ['sender', 'addr']] },
  { contract: 'vault', name: 'CollateralDeposited', fields: [['debtor', 'addr'], ['amount', 'yen'], ['total', 'yen']] },
  { contract: 'vault', name: 'CollateralWithdrawn', fields: [['debtor', 'addr'], ['amount', 'yen'], ['total', 'yen']] },
  { contract: 'vault', name: 'CollateralSeized', fields: [['debtor', 'addr'], ['invoiceId', 'id'], ['amount', 'yen'], ['remaining', 'yen']] },
  { contract: 'vault', name: 'InterestClaimed', fields: [['debtor', 'addr'], ['amount', 'yen'], ['stillOwed', 'yen']] },
  { contract: 'vault', name: 'RewardsFunded', fields: [['from', 'addr'], ['amount', 'yen'], ['reserve', 'yen']] },
  { contract: 'vault', name: 'RewardsWithdrawn', fields: [['to', 'addr'], ['amount', 'yen'], ['reserve', 'yen']] },
  { contract: 'vault', name: 'AprSet', fields: [['bps', 'bps']] },
  { contract: 'vault', name: 'RequiredBpsSet', fields: [['grade', 'grade'], ['bps', 'bps']] },
  { contract: 'vault', name: 'RegistrySet', fields: [['registry', 'addr']] },
  { contract: 'vault', name: 'RoleGranted', fields: [['role', 'hash'], ['account', 'addr'], ['sender', 'addr']] },
  { contract: 'hook', name: 'CurveTrade', fields: [['invoiceId', 'id'], ['poolId', 'hash'], ['price', 'price'], ['fair', 'price'], ['deviationBps', 'num']] },
  { contract: 'hook', name: 'BandSet', fields: [['bandBps', 'num']] },
  { contract: 'market', name: 'PoolCreated', fields: [['id', 'id'], ['sqrtPriceX96', 'num'], ['fairPrice', 'price']] },
  { contract: 'market', name: 'BidsPosted', fields: [['id', 'id'], ['investor', 'addr'], ['positionId', 'num'], ['lower', 'num'], ['upper', 'num'], ['liquidity', 'num'], ['jpyc', 'yen']] },
  { contract: 'market', name: 'BidsWithdrawn', fields: [['id', 'id'], ['investor', 'addr'], ['positionId', 'num'], ['liquidity', 'num']] },
  { contract: 'market', name: 'Traded', fields: [['id', 'id'], ['user', 'addr'], ['sellInvoice', 'bool'], ['amountIn', 'yen'], ['amountOut', 'yen']] },
  { contract: 'token', name: 'Transfer', fields: [['from', 'addr'], ['to', 'addr'], ['value', 'yen']] },
];

/// Plain-language headline for each event, shown in the feed.
function headline(r: Row): string {
  const v = r.values;
  const inv = v.id ?? v.invoiceId;
  switch (r.spec.name) {
    case 'InvoiceRegistered': return `Invoice #${inv} registered for ${fmt(v.face, 'yen')}, due ${fmt(v.maturity, 'time')}`;
    case 'InvoiceMetadata': return `Invoice #${inv} is ${v.ref}${v.supplierName ? ` from ${v.supplierName}` : ''}${v.debtorName ? ` to ${v.debtorName}` : ''}`;
    case 'InvoiceAccepted': return `Buyer approved invoice #${inv}; ${fmt(v.face, 'yen')} of tokens minted`;
    case 'InvoiceRejected': return `Buyer rejected invoice #${inv}: ${v.reason}`;
    case 'InvoicePaid': return `${fmt(v.amount, 'yen')} repaid on invoice #${inv} (total ${fmt(v.funded, 'yen')})`;
    case 'InvoiceSettled': return `Invoice #${inv} settled in full`;
    case 'InvoiceDefaulted': return `Invoice #${inv} defaulted with ${fmt(v.funded, 'yen')} of ${fmt(v.face, 'yen')} recovered`;
    case 'InvoiceFrozen': return `Operator ${v.frozen === 'true' ? 'froze' : 'unfroze'} invoice #${inv}`;
    case 'Redeemed': return `${short(v.holder)} redeemed ${fmt(v.tokens, 'yen')} of invoice #${inv} for ${fmt(v.jpycPaid, 'yen')}`;
    case 'CompanyNamed': return `${short(v.company)} is now "${v.name}"`;
    case 'DebtorRated': return `${short(v.debtor)} rated G${v.grade}, rate ${fmt(v.rateBps, 'bps')}`;
    case 'CreditEventRecorded': return `${fmt(v.kind, 'credit')} recorded for ${short(v.debtor)} on invoice #${inv}; rate now ${fmt(v.rateBps, 'bps')}`;
    case 'CollateralDeposited': return `${short(v.debtor)} locked ${fmt(v.amount, 'yen')} collateral`;
    case 'CollateralWithdrawn': return `${short(v.debtor)} withdrew ${fmt(v.amount, 'yen')} collateral`;
    case 'CollateralSeized': return `${fmt(v.amount, 'yen')} of ${short(v.debtor)}'s collateral seized for invoice #${inv}`;
    case 'InterestClaimed': return `${short(v.debtor)} claimed ${fmt(v.amount, 'yen')} collateral interest`;
    case 'RewardsFunded': return `Reward pool funded with ${fmt(v.amount, 'yen')}`;
    case 'CurveTrade': return `Trade on invoice #${inv} at ${fmt(v.price, 'price')} vs fair ${fmt(v.fair, 'price')} (${v.deviationBps} bps off curve)`;
    case 'PoolCreated': return `Uniswap v4 pool opened for invoice #${inv} at ${fmt(v.fairPrice, 'price')}`;
    case 'BidsPosted': return `${short(v.investor)} bid ${fmt(v.jpyc, 'yen')} on invoice #${inv}`;
    case 'BidsWithdrawn': return `${short(v.investor)} withdrew bid #${v.positionId} on invoice #${inv}`;
    case 'Traded': return `${short(v.user)} ${v.sellInvoice === 'true' ? 'sold' : 'bought'} invoice #${inv} tokens`;
    case 'Transfer': return v.from === ZERO ? `${fmt(v.value, 'yen')} ${r.alias.replace('tegata_invoice_', 'invoice #')} tokens minted to ${short(v.to)}`
      : v.to === ZERO ? `${fmt(v.value, 'yen')} ${r.alias.replace('tegata_invoice_', 'invoice #')} tokens burned` : `${fmt(v.value, 'yen')} ${r.alias.replace('tegata_invoice_', 'invoice #')} tokens moved ${short(v.from)} → ${short(v.to)}`;
    default: return r.spec.fields.map(([k, kind]) => `${k} ${fmt(v[k], kind)}`).join(' · ');
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';
function fmt(raw: string | undefined, kind: Kind): string {
  if (raw === undefined || raw === null) return '—';
  try {
    switch (kind) {
      case 'yen': return yen(BigInt(raw));
      case 'price': return price(BigInt(raw));
      case 'bps': return `${(Number(raw) / 100).toFixed(2)}%`;
      case 'time': return jst(Number(raw));
      case 'grade': return Number(raw) === 0 ? 'unrated' : `G${raw}`;
      case 'credit': return ['On-time payment', 'Late payment', 'Default'][Number(raw)] ?? raw;
      case 'addr': return short(raw);
      case 'hash': {
        // MultiBaas returns bytes32 as a JSON byte array.
        const hex = raw.startsWith('[') ? `0x${(JSON.parse(raw) as number[]).map((b) => b.toString(16).padStart(2, '0')).join('')}` : raw;
        return /^0x0+$/.test(hex) ? 'admin role' : `${hex.slice(0, 10)}…`;
      }
      default: return String(raw);
    }
  } catch {
    return String(raw);
  }
}

async function fetchEvents(spec: Spec): Promise<Row[]> {
  const c = CONTRACTS[spec.contract];
  const query = {
    events: [{
      eventName: spec.name,
      select: [
        ...spec.fields.map(([name], inputIndex) => ({ type: 'input' as const, inputIndex, alias: name })),
        { type: 'triggered_at' as const, alias: '_at' },
        { type: 'block_number' as const, alias: '_block' },
        { type: 'tx_hash' as const, alias: '_tx' },
        { type: 'contract_address_alias' as const, alias: '_alias' },
      ],
      filter: { fieldType: c.filter, operator: 'equal', value: c.alias },
    }],
  };
  const rows: Record<string, any>[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await runEventQuery(query as any, offset, 50);
    rows.push(...page);
    if (page.length < 50) break;
  }
  return rows.map((r) => ({
    spec,
    at: Math.floor(new Date(String(r._at).replace(' ', 'T').replace(/\+00$/, 'Z')).getTime() / 1000),
    block: Number(r._block),
    tx: String(r._tx),
    alias: String(r._alias ?? c.alias),
    values: Object.fromEntries(spec.fields.map(([k]) => [k, r[k] === undefined ? undefined : String(r[k])])) as Record<string, string>,
  }));
}

/// Runs `jobs` with at most `n` in flight (MultiBaas and the proxy both appreciate not getting 36 requests at once).
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]().then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
    }
  }));
  return out;
}

export function EventsPage({ chainId }: { chainId: number }) {
  const [rows, setRows] = useState<Row[]>();
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<Date>();
  const [contract, setContract] = useState<ContractKey | 'all'>('all');
  const [eventName, setEventName] = useState('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const results = await pool(EVENTS.map((spec) => () => fetchEvents(spec)), 6);
    const ok: Row[] = [];
    const bad: string[] = [];
    results.forEach((r, i) => (r.status === 'fulfilled' ? ok.push(...r.value) : bad.push(`${EVENTS[i].contract}.${EVENTS[i].name}`)));
    ok.sort((a, b) => b.block - a.block || b.at - a.at);
    setRows(ok);
    setFailed(bad);
    setUpdated(new Date());
    setLoading(false);
  }, [chainId]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const byContract = new Map<ContractKey, number>();
    const byEvent = new Map<string, number>();
    for (const r of rows ?? []) {
      byContract.set(r.spec.contract, (byContract.get(r.spec.contract) ?? 0) + 1);
      byEvent.set(r.spec.name, (byEvent.get(r.spec.name) ?? 0) + 1);
    }
    return { byContract, byEvent };
  }, [rows]);

  const visible = (rows ?? []).filter((r) =>
    (contract === 'all' || r.spec.contract === contract)
    && (eventName === 'all' || r.spec.name === eventName)
    && (!search.trim() || `${r.spec.name} ${headline(r)} ${r.tx} ${Object.values(r.values).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())));
  const eventNames = [...new Set(EVENTS.filter((e) => contract === 'all' || e.contract === contract).map((e) => e.name))];
  const maxContract = Math.max(1, ...counts.byContract.values());
  const explorer = (hash: string) => (chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${hash}` : undefined);

  return (
    <div className="events-page">
      <section className="card field-ink curvegrid-hero">
        <div className="curvegrid-brand">
          <span className="curvegrid-badge">Curvegrid MultiBaas</span>
          <h2>On-chain event explorer</h2>
          <p className="muted">
            Every event from the Tegata contracts on Sepolia, served by MultiBaas Event Queries. MultiBaas indexes the
            contracts from their deploy block under named aliases, so this page never scans the chain over RPC.
            New invoice tokens are added to the index automatically by our MultiBaas webhook.
          </p>
        </div>
        <div className="curvegrid-stats">
          <div><b>{rows ? rows.length.toLocaleString() : '…'}</b><span>events indexed</span></div>
          <div><b>{counts.byEvent.size || '…'}</b><span>event types seen</span></div>
          <div><b>{Object.keys(CONTRACTS).length}</b><span>contract aliases</span></div>
          <div><b>{rows?.[0] ? rows[0].block.toLocaleString() : '…'}</b><span>latest block</span></div>
        </div>
      </section>

      <section className="grid events-overview">
        <div className="card">
          <div className="panel-title"><h3>Events by contract</h3><span className="muted small-text">MultiBaas alias</span></div>
          {(Object.keys(CONTRACTS) as ContractKey[]).map((k) => {
            const n = counts.byContract.get(k) ?? 0;
            return (
              <button key={k} className={`events-bar${contract === k ? ' active' : ''}`} onClick={() => { setContract(contract === k ? 'all' : k); setEventName('all'); }}>
                <span className="events-bar-label">{CONTRACTS[k].label}<code>{CONTRACTS[k].alias}</code></span>
                <span className="events-bar-track"><span style={{ width: `${(n / maxContract) * 100}%` }} /></span>
                <b>{n}</b>
              </button>
            );
          })}
        </div>
        <div className="card">
          <div className="panel-title"><h3>How it is wired</h3></div>
          <ol className="events-wiring">
            <li><b>Link.</b> <code>npm run link</code> uploads the contract ABIs to MultiBaas, names each contract with an alias and turns on event sync from the deploy block.</li>
            <li><b>Index.</b> MultiBaas decodes every log into typed fields. This page asks for them with one Event Query per event type.</li>
            <li><b>Webhook.</b> <code>event.emitted</code> webhooks (HMAC-verified) register each new invoice token, so its transfers show up here too. Our MultiBaas plan caps linked contracts and sync depth, so transfers of some newer invoice tokens are not indexed.</li>
            <li><b>Proxy.</b> Queries run through <code>/api/mb/query</code>, so the MultiBaas API key never reaches the browser.</li>
          </ol>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Event feed</h3>
          <span className="muted small-text">{updated ? `Updated ${updated.toLocaleTimeString()}` : 'Loading from MultiBaas…'}</span>
        </div>
        <div className="row events-filters">
          <select value={contract} onChange={(e) => { setContract(e.target.value as ContractKey | 'all'); setEventName('all'); }}>
            <option value="all">All contracts</option>
            {(Object.keys(CONTRACTS) as ContractKey[]).map((k) => <option key={k} value={k}>{CONTRACTS[k].label}</option>)}
          </select>
          <select value={eventName} onChange={(e) => setEventName(e.target.value)}>
            <option value="all">All events</option>
            {eventNames.map((n) => <option key={n} value={n}>{n} ({counts.byEvent.get(n) ?? 0})</option>)}
          </select>
          <input placeholder="Search invoice, address, tx…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="ghost" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        {failed.length > 0 && <p className="form-warning">MultiBaas did not answer for: {failed.join(', ')}</p>}
        {!rows ? (
          <p className="empty-state">Querying MultiBaas…</p>
        ) : visible.length === 0 ? (
          <p className="empty-state">No events match.</p>
        ) : (
          <div className="events-table">
            <table>
              <thead><tr><th>When</th><th>Contract</th><th>Event</th><th>What happened</th><th>Transaction</th></tr></thead>
              <tbody>
                {visible.slice(0, 300).map((r) => (
                  <tr key={`${r.tx}-${r.spec.contract}-${r.spec.name}-${r.alias}-${JSON.stringify(r.values)}`}>
                    <td className="small-text">{jst(r.at)}</td>
                    <td><span className={`badge events-${r.spec.contract}`}>{CONTRACTS[r.spec.contract].label}</span><div className="mono muted small-text">{r.alias}</div></td>
                    <td className="mono">{r.spec.name}</td>
                    <td>{headline(r)}</td>
                    <td className="mono small-text">
                      {explorer(r.tx) ? <a href={explorer(r.tx)} target="_blank" rel="noreferrer">{short(r.tx)}</a> : short(r.tx)}
                      <div className="muted">block {r.block.toLocaleString()}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length > 300 && <p className="muted small-text">Showing the latest 300 of {visible.length}. Filter to narrow down.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
