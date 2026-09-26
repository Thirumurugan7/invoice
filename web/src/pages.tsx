import { useEffect, useState } from 'react';
import { isAddress, keccak256, parseUnits, toBytes, type Address } from 'viem';
import { ABI, sha256File, type Deployment, type Session } from './chain';
import { jst, price, short, yen } from './errors';
import { fetchBookFromMultiBaas, multibaasEnabled, type MbBook } from './multibaas';
import { STATUS, type Book, type InvoiceRow } from './state';

type Send = (label: string, address: Address, abi: readonly unknown[], fn: string, args: unknown[]) => Promise<void>;
type Props = { dep: Deployment; s: Session; book: Book; send: Send; onViewAll?: () => void };
const MAX = 2n ** 255n;
const u = (v: string) => parseUnits(v || '0', 18);
const daysLeft = (inv: InvoiceRow, now: number) => Math.max(0, (inv.maturity - now) / 86400);
const deadline = (book: Book) => BigInt(book.chainTime + 600); // 10 min
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const impliedYield = (p: bigint, days: number) => (days <= 0 || p === 0n ? 0 : ((1e18 / Number(p) - 1) * 365) / days) * 100;

function F(p: { label: string; value: string; set: (v: string) => void; ph?: string }) {
  return (
    <label className="field">
      <span>{p.label}</span>
      <input value={p.value} placeholder={p.ph} onChange={(e) => p.set(e.target.value)} />
    </label>
  );
}

function Badge({ inv }: { inv: InvoiceRow }) {
  if (inv.frozen) return <span className="badge butter">Frozen</span>;
  const cls = inv.status === 2 ? 'mint' : inv.status === 4 ? 'ink' : inv.status === 1 ? 'butter' : 'negative';
  return <span className={`badge ${cls}`}>{STATUS[inv.status]}</span>;
}

export function SupplierPage({ dep, s, book, send }: Props) {
  const [debtor, setDebtor] = useState('');
  const [face, setFace] = useState('500000');
  const [days, setDays] = useState('60');
  const [docHash, setDocHash] = useState<`0x${string}`>();
  const [fileName, setFileName] = useState('');
  const [ref, setRef] = useState('');
  const mine = book.invoices.filter((i) => i.supplier.toLowerCase() === s.account.toLowerCase() || i.myTokens > 0n);
  return (
    <div className="grid">
      <section className="card">
        <h3>Upload invoice for liquidity</h3>
        <p className="muted">{book.me.verified ? `Permission policy active for ${book.me.name}` : 'Under review — an operator must approve this company before funding.'}</p>
        <label className="field">
          <span>Invoice PDF</span>
          <input
            type="file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFileName(f.name);
                if (!ref) setRef(f.name.replace(/\.[^.]+$/, '').replace(/^invoice-/i, ''));
                setDocHash(await sha256File(f));
              }
            }}
          />
        </label>
        {docHash && <p className="muted mono">{fileName}: {short(docHash)}</p>}
        <F label="Invoice number (請求書番号)" value={ref} set={setRef} ph="SKR-2026-0926-001" />
        <F label="Buyer company wallet" value={debtor} set={setDebtor} ph="0x… approved company" />
        <F label="Face value (JPYC)" value={face} set={setFace} />
        <F label="Days to maturity" value={days} set={setDays} />
        <p className="muted">
          Investor bids are guided by live credit rating, settlement history, and the current liquidity curve.
        </p>
        <button
          disabled={!isAddress(debtor)}
          onClick={() =>
            send('Register invoice', dep.registry, ABI.registry, 'registerInvoice', [
              debtor,
              u(face),
              BigInt(book.chainTime + Number(days) * 86400),
              docHash ?? keccak256(toBytes(`${debtor}-${face}-${days}-${Date.now()}`)),
              ref,
            ])
          }
        >
          Upload invoice
        </button>
      </section>
      {mine.map((inv) => (
        <SellCard key={inv.id} inv={inv} dep={dep} book={book} send={send} s={s} />
      ))}
    </div>
  );
}

function SellCard({ inv, dep, book, send, s }: { inv: InvoiceRow; dep: Deployment; book: Book; send: Send; s: Session }) {
  const [amt, setAmt] = useState('100000');
  const fairValue = (u(amt) * inv.fair) / 10n ** 18n;
  return (
    <section className="card">
      <h3>
        Invoice #{inv.id} <span className="mono muted">{inv.ref}</span> <Badge inv={inv} />
      </h3>
      <p className="muted">
        {inv.debtorName || short(inv.debtor)} · face {yen(inv.face)} · due {jst(inv.maturity)}
      </p>
      <InvoiceRecord inv={inv} s={s} />
      <p>Available to sell {yen(inv.myTokens)} face value</p>
      <p className="muted">Buyer grade G{inv.debtorGrade} · pricing rate {pct(inv.rateBps)} (at upload {pct(inv.rateAtIssueBps)})</p>
      {inv.status === 2 && inv.poolCreated && (
        <>
          <F label="Sell face amount" value={amt} set={setAmt} />
          <p className="muted">
            Indicative liquidity: <b>{yen(fairValue)}</b> (price {price(inv.fair)}) · minimum proceeds set to 98%
          </p>
          <div className="row">
            <button className="ghost" onClick={() => send('Approve invoice token', inv.token, ABI.token, 'approve', [dep.market, MAX])}>Approve</button>
            <button onClick={() => send(`Sell invoice #${inv.id} for early cash`, dep.market, ABI.market, 'sell', [BigInt(inv.id), u(amt), (fairValue * 98n) / 100n, deadline(book)])}>
              Get paid early
            </button>
          </div>
        </>
      )}
      {(inv.status === 4 || inv.status === 5) && inv.myTokens > 0n && (
        <button onClick={() => send('Redeem', dep.registry, ABI.registry, 'redeem', [BigInt(inv.id), inv.myTokens])}>Redeem {yen(inv.myTokens)}</button>
      )}
      {inv.status === 1 && <p className="muted">Awaiting buyer confirmation before investor bids open.</p>}
      {book && null}
    </section>
  );
}

function InvoiceRecord({ inv, s }: { inv: InvoiceRow; s: Session }) {
  const [json, setJson] = useState<string>();
  return (
    <details
      className="record"
      onToggle={(e) => {
        if (!(e.target as HTMLDetailsElement).open) return;
        (s.pub.readContract({ address: inv.token, abi: ABI.token as any, functionName: 'contractURI' }) as Promise<string>)
          .then((uri) => setJson(JSON.stringify(JSON.parse(uri.slice(uri.indexOf(',') + 1)), null, 2)))
          .catch((e) => setJson(String(e?.shortMessage ?? e)));
      }}
    >
      <summary className="muted small-text">Auditable invoice record</summary>
      <pre className="mono">{json ?? 'loading…'}</pre>
    </details>
  );
}

export function DebtorPage({ dep, s, book, send }: Props) {
  const mine = book.invoices.filter((i) => i.debtor.toLowerCase() === s.account.toLowerCase());
  const [amt, setAmt] = useState('20000');
  const m = book.me;
  const weak = m.grade >= 4;
  return (
    <div className="grid">
      <section className="card">
        <h3>Invoice approvals</h3>
        <p>{book.me.name || short(s.account)} · payment balance {yen(book.me.jpyc)}</p>
        <button className="ghost" onClick={() => send('Approve JPYC for payments', dep.jpyc, ABI.jpyc, 'approve', [dep.registry, MAX])}>
          Approve settlement account
        </button>
      </section>
      <section className="card">
        <h3>Settlement reserve</h3>
        <p className="muted">
          {m.grade === 0
            ? 'Not rated yet.'
            : weak
              ? `Grade G${m.grade}: additional reserve required before new invoices can enter the marketplace.`
              : `Grade G${m.grade}: optional reserve can improve investor pricing by reducing settlement risk.`}
        </p>
        <p>
          Outstanding {yen(m.outstanding)} · reserved <b>{yen(m.collateral)}</b> · required {yen(m.collateralRequired)} · coverage {(m.coverageBps / 100).toFixed(0)}%
        </p>
        <F label="Amount (JPYC)" value={amt} set={setAmt} />
        <div className="row">
          {m.jpycAllowanceVault < u(amt) && (
            <button className="ghost" onClick={() => send('Approve JPYC for collateral', dep.jpyc, ABI.jpyc, 'approve', [dep.vault, MAX])}>Approve</button>
          )}
          <button onClick={() => send(`Lock ${amt} JPYC collateral`, dep.vault, ABI.vault, 'deposit', [u(amt)])}>Add reserve</button>
          <button className="ghost" onClick={() => send(`Withdraw ${amt} JPYC collateral`, dep.vault, ABI.vault, 'withdraw', [u(amt)])}>Release reserve</button>
        </div>
        <p className="muted small-text">If settlement fails, reserved funds are routed to invoice holders automatically.</p>
      </section>
      {mine.length === 0 && <p className="muted">No invoices addressed to you.</p>}
      {mine.map((inv) => (
        <section className="card" key={inv.id}>
          <h3>
            Invoice #{inv.id} <span className="mono muted">{inv.ref}</span> <Badge inv={inv} />
          </h3>
          <p className="muted">from {inv.supplierName || short(inv.supplier)} · due {jst(inv.maturity)}</p>
          <p>
            Face {yen(inv.face)} · funded {yen(inv.funded)}
          </p>
          {inv.status === 1 && (
            <div className="row">
              <button onClick={() => send('Accept (発生記録)', dep.registry, ABI.registry, 'acceptInvoice', [BigInt(inv.id)])}>Approve invoice</button>
              <button className="danger" onClick={() => send('Reject', dep.registry, ABI.registry, 'rejectInvoice', [BigInt(inv.id), 'disputed'])}>
                Reject
              </button>
            </div>
          )}
          {inv.status === 2 && (
            <button onClick={() => send('Pay invoice in JPYC', dep.registry, ABI.registry, 'pay', [BigInt(inv.id), inv.face - inv.funded])}>
              Settle {yen(inv.face - inv.funded)}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

export function InvestorPage({ dep, s, book, send }: Props) {
  const [bid, setBid] = useState('300000');
  const [buyAmt, setBuyAmt] = useState('50000');
  const [offset, setOffset] = useState('0');
  return (
    <div>
      {s.kind !== 'readonly' && !book.me.canHold && (
        <div className="banner error">
          This wallet is still under review. Investor approval is required before it can place bids or hold invoice positions.
        </div>
      )}
      <p className="muted">
        Available funds {yen(book.me.jpyc)} · bid band ±{String(book.bandBps)} bps ·{' '}
        <button className="ghost small" onClick={() => send('Approve JPYC for market', dep.jpyc, ABI.jpyc, 'approve', [dep.market, MAX])}>
          Approve bid funding
        </button>
      </p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Buyer</th>
            <th>Face</th>
            <th>Days</th>
            <th>Credit</th>
            <th>Indicative</th>
            <th>Bid price</th>
            <th>Spread</th>
            <th>Yield</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {book.invoices.map((inv) => {
            const d = daysLeft(inv, book.chainTime);
            return (
              <tr key={inv.id}>
                <td>
                  {inv.id} <div className="mono muted small-text">{inv.ref}</div>
                </td>
                <td>{inv.debtorName || short(inv.debtor)}</td>
                <td>{yen(inv.face)}</td>
                <td>{d.toFixed(1)}</td>
                <td title={`rate at registration ${pct(inv.rateAtIssueBps)}`}>
                  G{inv.debtorGrade} · {pct(inv.rateBps)}
                  {inv.debtorCoverageBps > 0 && <div className="muted small-text">🔒 {(inv.debtorCoverageBps / 100).toFixed(0)}% collateral</div>}
                </td>
                <td>{price(inv.fair)}</td>
                <td>{inv.poolPrice ? price(inv.poolPrice) : '—'}</td>
                <td>{inv.deviationBps !== undefined ? `${inv.deviationBps} bps` : '—'}</td>
                <td>{inv.poolPrice ? `${impliedYield(inv.poolPrice, d).toFixed(2)}%` : pct(inv.rateBps)}</td>
                <td>
                  <Badge inv={inv} />
                </td>
                <td className="actions">
                  {inv.status === 2 && !inv.poolCreated && (
                    <button className="small" onClick={() => send('Create pool on curve', dep.market, ABI.market, 'createPool', [BigInt(inv.id)])}>Open bidding</button>
                  )}
                  {inv.poolCreated && inv.tradable && (
                    <button
                      className="small"
                      onClick={() => send(`Post ${bid} JPYC bids`, dep.market, ABI.market, 'postBids', [BigInt(inv.id), u(bid), Number(offset), 150, deadline(book)])}
                    >
                      Place bid
                    </button>
                  )}
                  {inv.myPositions.map((p) => (
                    <button key={String(p.pid)} className="small ghost" onClick={() => send(`Withdraw bid position #${p.pid}`, dep.market, ABI.market, 'withdrawBids', [p.pid, deadline(book)])}>
                      Withdraw #{String(p.pid)}
                    </button>
                  ))}
                  {inv.poolCreated && inv.tradable && (
                    <button
                      className="small ghost"
                      onClick={() =>
                        send(`Buy with ${buyAmt} JPYC`, dep.market, ABI.market, 'buy', [BigInt(inv.id), u(buyAmt), (u(buyAmt) * 10n ** 18n * 100n) / (inv.fair * 102n), deadline(book)])
                      }
                    >
                      Invest
                    </button>
                  )}
                  {(inv.status === 4 || inv.status === 5) && inv.myTokens > 0n && (
                    <button className="small" onClick={() => send('Redeem', dep.registry, ABI.registry, 'redeem', [BigInt(inv.id), inv.myTokens])}>Redeem</button>
                  )}
                  {inv.status === 2 && book.chainTime > inv.maturity + 3 * 86400 && (
                    <button className="small danger" onClick={() => send('Mark default', dep.registry, ABI.registry, 'markDefault', [BigInt(inv.id)])}>Mark default</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <F label="Bid size (JPYC)" value={bid} set={setBid} />
        <F label="Price offset below indicative (ticks, ×10)" value={offset} set={setOffset} />
        <F label="Investment size (JPYC)" value={buyAmt} set={setBuyAmt} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Operator
export function OperatorPage({ dep, book, send }: Props) {
  const [who, setWho] = useState('');
  const [corp, setCorp] = useState('');
  const [name, setName] = useState('');
  const [id, setId] = useState('1');
  const [debtor, setDebtor] = useState('');
  const [grade, setGrade] = useState('2');
  const [base, setBase] = useState('');
  const [inv, setInv] = useState('');
  return (
    <div className="grid">
      <section className="card">
        <h3>Company permission policy</h3>
        <p className="muted">
          {book.me.isOperator ? 'Operator access active.' : 'You are not an operator.'} Production approvals can be delegated through a secure cloud signing policy.
        </p>
        <F label="Company wallet" value={who} set={setWho} ph="0x…" />
        <F label="法人番号 (corporate number)" value={corp} set={setCorp} ph="1010001000001" />
        <F label="Company name" value={name} set={setName} />
        <button disabled={!isAddress(who) || !corp} onClick={() => send('Verify company', dep.registry, ABI.registry, 'verifyCompany', [who, keccak256(toBytes(`corp:${corp}`)), name])}>
          Approve company
        </button>
      </section>
      <section className="card">
        <h3>Investor permissions</h3>
        <p className="muted">Only approved investors, companies, and venues can hold invoice positions.</p>
        <F label="Investor wallet" value={inv} set={setInv} ph="0x…" />
        <div className="row">
          <button disabled={!isAddress(inv)} onClick={() => send('Approve investor', dep.registry, ABI.registry, 'approveInvestor', [inv, true])}>Approve</button>
          <button className="ghost" disabled={!isAddress(inv)} onClick={() => send('Revoke investor', dep.registry, ABI.registry, 'approveInvestor', [inv, false])}>Revoke</button>
        </div>
      </section>
      <section className="card">
        <h3>Buyer credit rating</h3>
        <p className="muted">
          Investor pricing starts from base {pct(book.baseRateBps)}, buyer grade, default history, late payments, and on-time settlement records.
        </p>
        <F label="Buyer wallet" value={debtor} set={setDebtor} ph="0x…" />
        <label className="field">
          <span>Grade</span>
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {[1, 2, 3, 4, 5].map((g) => (<option key={g} value={g}>G{g}</option>))}
          </select>
        </label>
        <button disabled={!isAddress(debtor)} onClick={() => send(`Rate debtor G${grade}`, dep.risk, ABI.risk, 'rate', [debtor, Number(grade)])}>Rate</button>
        <F label="Base rate (bps)" value={base} set={setBase} ph={String(book.baseRateBps)} />
        <button className="ghost" disabled={!base} onClick={() => send('Set base rate', dep.risk, ABI.risk, 'setBaseRate', [Number(base)])}>Set base rate</button>
      </section>
      <section className="card">
        <h3>Invoice review controls</h3>
        <F label="Invoice id" value={id} set={setId} />
        <div className="row">
          <button className="danger" onClick={() => send('Freeze', dep.registry, ABI.registry, 'setFrozen', [BigInt(id || '0'), true])}>Freeze</button>
          <button className="ghost" onClick={() => send('Unfreeze', dep.registry, ABI.registry, 'setFrozen', [BigInt(id || '0'), false])}>Unfreeze</button>
        </div>
      </section>
    </div>
  );
}

export function PermissionsPage({ s, book }: Props) {
  const policy = [
    { label: 'Company KYB', value: book.me.verified ? 'Approved' : 'Under review', tone: book.me.verified ? 'mint' : 'butter' },
    { label: 'Investor access', value: book.me.approvedInvestor ? 'Approved' : 'Under review', tone: book.me.approvedInvestor ? 'mint' : 'butter' },
    { label: 'Delegated signing', value: book.me.isOperator ? 'Operator enabled' : 'Policy controlled', tone: book.me.isOperator ? 'ink' : 'lilac' },
    { label: 'Invoice custody', value: book.me.canHold ? 'Allowed' : 'Restricted', tone: book.me.canHold ? 'mint' : 'butter' },
  ];
  return (
    <div className="grid">
      <section className="hero permissions-hero">
        <span className="tag">Wallet & permissions</span>
        <span className="figure">{book.me.canHold ? 'Ready' : 'Review'}</span>
        <span className="muted small-text">Permission policy for {book.me.name || short(s.account)}</span>
        <div className="hero-foot">
          <span className="mono small-text">{short(s.account)}</span>
          <button onClick={() => navigator.clipboard?.writeText(s.account)}>Copy wallet</button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-title"><h3>Policy checks</h3><span className="muted small-text">delegated controls</span></div>
        {policy.map((p) => (
          <div className="list-row" key={p.label}>
            <div className="who">
              <b>{p.label}</b>
              <span className="muted">{p.label === 'Delegated signing' ? 'Used for operator approvals and transaction submission' : 'Required before marketplace activity'}</span>
            </div>
            <span className={`badge ${p.tone}`}>{p.value}</span>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="panel-title"><h3>Account balances</h3></div>
        <div className="metric-list">
          <div><span>Bid funding</span><b>{yen(book.me.jpyc)}</b></div>
          <div><span>Settlement reserve</span><b>{yen(book.me.collateral)}</b></div>
          <div><span>Outstanding exposure</span><b>{yen(book.me.outstanding)}</b></div>
        </div>
      </section>
    </div>
  );
}

export function ActivityPage({ book }: Props) {
  const rows = book.invoices
    .slice()
    .sort((a, b) => b.id - a.id)
    .slice(0, 12);
  return (
    <section className="panel activity-panel">
      <div className="panel-title">
        <h3>Transaction activity</h3>
        <span className="muted small-text">submitted · awaiting confirmation · funded · under review</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty-state">No invoice activity yet.</p>
      ) : (
        rows.map((inv) => {
          const status = inv.frozen ? 'Under review' : inv.status === 1 ? 'Awaiting confirmation' : inv.status === 2 ? 'Funded' : inv.status === 4 ? 'Settled' : STATUS[inv.status];
          const tone = inv.frozen || inv.status === 1 ? 'butter' : inv.status === 2 ? 'mint' : inv.status === 4 ? 'ink' : 'negative';
          return (
            <div className="activity-row" key={inv.id}>
              <div className="activity-dot" />
              <div className="who">
                <b>Invoice #{inv.id} {inv.ref}</b>
                <span className="muted">{inv.supplierName || short(inv.supplier)} → {inv.debtorName || short(inv.debtor)} · due {jst(inv.maturity)}</span>
              </div>
              <span className="amt">{yen(inv.face)}</span>
              <span className={`badge ${tone}`}>{status}</span>
            </div>
          );
        })
      )}
    </section>
  );
}

const CALENDAR_DAYS = 35;
const CALENDAR_COLUMNS = 8;

function MaturityBoard({ book }: { book: Book }) {
  const open = book.invoices.filter((i) => i.status === 1 || i.status === 2);
  const calendar = Array.from({ length: CALENDAR_COLUMNS }, (_, index) => {
    const offset = Math.round(index * (CALENDAR_DAYS - 1) / (CALENDAR_COLUMNS - 1));
    const timestamp = book.chainTime + offset * 86400;
    const date = new Date(timestamp * 1000);
    return {
      index,
      offset,
      day: date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', day: 'numeric' }),
      weekday: date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' }),
      weekend: ['Sat', 'Sun'].includes(date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' })),
    };
  });
  const total = open.reduce((sum, inv) => sum + inv.face, 0n);
  const funded = open.reduce((sum, inv) => sum + inv.funded, 0n);
  const nextDue = [...open].sort((a, b) => a.maturity - b.maturity)[0];

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Liquidity outlook</span>
          <h3>Invoice liquidity calendar</h3>
        </div>
        <span className="muted small-text">Next {CALENDAR_DAYS} days</span>
      </div>
      <div className="timeline-metrics">
        <div><span>Open face value</span><b>{yen(total)}</b></div>
        <div><span>Liquidity received</span><b>{yen(funded)}</b></div>
        <div><span>Next settlement</span><b>{nextDue ? `${Math.ceil(daysLeft(nextDue, book.chainTime))} ${Math.ceil(daysLeft(nextDue, book.chainTime)) === 1 ? 'day' : 'days'}` : '—'}</b></div>
      </div>
      {open.length === 0 ? (
        <p className="empty-state">No open invoices on the books right now.</p>
      ) : (
        <div className="schedule-scroll" aria-label="Invoice liquidity calendar">
          <div className="schedule" style={{ ['--calendar-days' as any]: CALENDAR_COLUMNS }}>
            <div className="schedule-corner">Invoices</div>
            <div className="schedule-dates">
              {calendar.map((date) => (
                <div className={`${date.weekend ? 'weekend ' : ''}${date.index === 0 ? 'today' : ''}`} key={date.index}>
                  <span>{date.weekday}</span><b>{date.day}</b>
                </div>
              ))}
            </div>
            {open.map((inv) => {
              const dueDays = Math.min(CALENDAR_DAYS - 1, Math.max(0, Math.ceil(daysLeft(inv, book.chainTime))));
              const due = Math.round(dueDays * (CALENDAR_COLUMNS - 1) / (CALENDAR_DAYS - 1));
              const start = Math.max(0, due - 2);
              const span = Math.min(4, CALENDAR_COLUMNS - start);
              return (
                <div className="schedule-row" key={inv.id}>
                  <div className="schedule-who">
                    <span className="invoice-avatar">{(inv.debtorName || 'B').charAt(0)}</span>
                    <span><b>{inv.debtorName || short(inv.debtor)}</b><small>#{inv.id} · G{inv.debtorGrade}</small></span>
                  </div>
                  <div className="schedule-track">
                    {calendar.map((date) => <i className={date.weekend ? 'weekend' : ''} key={date.index} />)}
                    <div
                      className={inv.status === 1 || inv.frozen ? 'schedule-event pending' : 'schedule-event funded'}
                      style={{ gridColumn: `${start + 1} / span ${span}` }}
                      title={`Invoice #${inv.id} · ${yen(inv.face)} · due ${jst(inv.maturity)}`}
                    >
                      <span>{inv.status === 1 ? 'Awaiting confirmation' : 'Settlement'}</span>
                      <b>{yen(inv.face)}</b>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="today-line" />
          </div>
          <div className="calendar-legend"><span><i className="funded" /> Funded</span><span><i className="pending" /> Awaiting confirmation</span></div>
        </div>
      )}
    </section>
  );
}

function UpcomingSettlements({ book }: { book: Book }) {
  const rows = book.invoices
    .filter((i) => i.status === 2)
    .sort((a, b) => a.maturity - b.maturity)
    .slice(0, 6);
  return (
    <section className="panel">
      <div className="panel-title"><h3>Upcoming settlements</h3></div>
      {rows.length === 0 ? (
        <p className="empty-state">Nothing maturing yet.</p>
      ) : (
        rows.map((inv) => {
          const d = daysLeft(inv, book.chainTime);
          return (
            <div className="list-row" key={inv.id}>
              <div className="who">
                <b>{inv.debtorName || short(inv.debtor)}</b>
                <span className="muted">#{inv.id} {inv.ref} · due {jst(inv.maturity)}</span>
              </div>
              <span className="amt">{yen(inv.face - inv.funded)}</span>
              <span className={`pill-days${d <= 3 ? ' soon' : ''}`}>{d < 1 ? '<1d' : `${d.toFixed(0)}d`}</span>
            </div>
          );
        })
      )}
    </section>
  );
}

function NeedsAction({ book }: { book: Book }) {
  const rows = book.invoices.filter((i) => i.status === 1 || i.frozen).slice(0, 6);
  return (
    <section className="panel">
      <div className="panel-title"><h3>Needs your action</h3></div>
      {rows.length === 0 ? (
        <p className="empty-state">Nothing needs a hand — every invoice is either settling or on the curve.</p>
      ) : (
        rows.map((inv) => (
          <div className="list-row" key={inv.id}>
            <div className="who">
              <b>{inv.supplierName || short(inv.supplier)} → {inv.debtorName || short(inv.debtor)}</b>
              <span className="muted">#{inv.id} {inv.ref} · {yen(inv.face)}</span>
            </div>
            <span className="badge butter">{inv.frozen ? 'Frozen' : 'Awaiting acceptance'}</span>
          </div>
        ))
      )}
    </section>
  );
}

type AssistantMessage = { role: 'user' | 'assistant'; text: string };
type AgentName = 'GPT' | 'Claude' | 'Gemini';
type AgentStatus = Record<AgentName, boolean>;

function AssistantPanel() {
  const [provider, setProvider] = useState<AgentName>('GPT');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ GPT: false, Claude: false, Gemini: false });
  const [statusReady, setStatusReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attachment, setAttachment] = useState<{ name: string; text: string }>();
  const shortcuts = ['Review invoice risk', 'Prepare settlement report', 'Summarize investor bids'];

  useEffect(() => {
    fetch('/api/agents/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then(setStatus)
      .catch(() => {})
      .finally(() => setStatusReady(true));
  }, []);

  const submit = async (text: string) => {
    const clean = text.trim();
    if (!clean || loading) return;
    if (!status[provider]) {
      setMessages((current) => [...current, { role: 'assistant', text: `${provider} is not connected on this machine yet.` }]);
      return;
    }
    setMessages((current) => [...current, { role: 'user', text: clean }]);
    setDraft('');
    setLoading(true);
    try {
      const response = await fetch('/api/agents/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          prompt: attachment ? `${clean}\n\nAttached file: ${attachment.name}\n${attachment.text}` : clean,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The assistant could not respond.');
      setMessages((current) => [...current, { role: 'assistant', text: result.reply }]);
      setAttachment(undefined);
    } catch (error: any) {
      setMessages((current) => [...current, { role: 'assistant', text: String(error?.message ?? error) }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="assistant-panel">
      <div className="assistant-head">
        <div>
          <span className="eyebrow">Workflow assistant</span>
          <h3>AI operations desk</h3>
        </div>
        <div className="provider-switch" aria-label="AI provider">
          {(['GPT', 'Claude', 'Gemini'] as AgentName[]).map((name) => (
            <button key={name} className={provider === name ? 'active' : ''} onClick={() => setProvider(name)}>
              <i className={status[name] ? 'connected' : ''} />{name}
            </button>
          ))}
        </div>
      </div>

      <div className="assistant-body">
        {messages.length === 0 ? (
          <div className="assistant-welcome">
            <div className="assistant-symbol" aria-hidden="true"><span /><span /><span /></div>
            <h2>Welcome to your finance desk</h2>
            <p>What should {provider} handle today?</p>
            <div className={statusReady && status[provider] ? 'connection-state connected' : 'connection-state'}>
              <span />{!statusReady ? 'Checking connection…' : status[provider] ? `${provider} subscription connected` : provider === 'Gemini' ? 'Gemini CLI installation required' : `${provider} sign-in required`}
            </div>
            <div className="assistant-shortcuts">
              {shortcuts.map((label) => <button key={label} onClick={() => submit(label)}>{label}</button>)}
            </div>
          </div>
        ) : (
          <div className="assistant-messages">
            {messages.map((message, index) => (
              <div className={`assistant-message ${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>
            ))}
            {loading && <div className="assistant-message assistant loading-message">{provider} is working…</div>}
          </div>
        )}
      </div>

      <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); submit(draft); }}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Ask ${provider} to create a workflow...`} rows={2} />
        <div className="composer-actions">
          <div>
            <label className="assistant-file-button">
              {attachment ? attachment.name : 'Attach file'}
              <input
                type="file"
                accept=".txt,.md,.json,.csv,text/plain,text/markdown,application/json,text/csv"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) setAttachment({ name: file.name, text: (await file.text()).slice(0, 30_000) });
                }}
              />
            </label>
            <button type="button" className="ghost small" onClick={() => setDraft('Create a workflow that ')}>Create</button>
          </div>
          <button type="submit" className="send-button" disabled={!draft.trim() || loading || !statusReady || !status[provider]} aria-label="Send message">↑</button>
        </div>
      </form>
    </section>
  );
}

export function BookPage({ book, onViewAll }: Props) {
  const [mb, setMb] = useState<MbBook>();
  const [mbErr, setMbErr] = useState<string>();
  useEffect(() => {
    if (multibaasEnabled) fetchBookFromMultiBaas().then(setMb).catch((e) => setMbErr(String(e?.message ?? e)));
  }, [book.chainTime]);

  const active = book.invoices.filter((i) => i.status === 2);
  const outstanding = active.reduce((a, i) => a + (i.face - i.funded), 0n);

  return (
    <div>
      <MaturityBoard book={book} />
      <div className="grid">
        <UpcomingSettlements book={book} />
        <NeedsAction book={book} />
        <div className="hero">
          <span className="tag">Outstanding</span>
          <span><span className="figure">{yen(outstanding)}</span></span>
          <span className="muted small-text">across {active.length} active invoice{active.length === 1 ? '' : 's'}</span>
          <div className="hero-foot">
            <span className="small-text">{STATUS.slice(1).map((st, k) => `${st} ${book.invoices.filter((i) => i.status === k + 1).length}`).join(' · ')}</span>
            {onViewAll && <button onClick={onViewAll}>View invoices</button>}
          </div>
        </div>
        <AssistantPanel />
      </div>
      {mb && (
        <div className="grid">
          <section className="panel">
            <div className="panel-title"><h3>Credit events</h3><span className="muted small-text">MultiBaas Event Queries</span></div>
            {mb.credit.length === 0 && <p className="empty-state">none yet</p>}
            {mb.credit.map((c, k) => (
              <p key={k} className="mono small-text">
                {short(String(c.debtor))} {c.grade != null ? `rated G${c.grade}` : ['on-time', 'late', 'DEFAULT'][Number(c.kind)]} → {Number(c.rate_bps) / 100}% · {c.at}
              </p>
            ))}
          </section>
          <section className="panel">
            <div className="panel-title"><h3>Curve trades</h3><span className="muted small-text">MultiBaas Event Queries</span></div>
            {mb.trades.length === 0 && <p className="empty-state">none yet</p>}
            {mb.trades.map((t, k) => (
              <p key={k} className="mono small-text">
                #{t.id} price {price(BigInt(String(t.price)))} fair {price(BigInt(String(t.fair)))} · {t.at}
              </p>
            ))}
          </section>
        </div>
      )}
      {!multibaasEnabled && <p className="muted small-text" style={{ marginTop: 12 }}>Source: direct RPC — set VITE_MB_BASE_URL/VITE_MB_API_KEY for MultiBaas-indexed event queries.</p>}
      {mbErr && <p className="error small-text">MultiBaas error — {mbErr}</p>}
    </div>
  );
}
