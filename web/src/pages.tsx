import { useEffect, useState } from 'react';
import { isAddress, keccak256, parseUnits, toBytes, type Address } from 'viem';
import { ABI, sha256File, type Deployment, type Session } from './chain';
import { jst, price, short, yen } from './errors';
import { fetchBookFromMultiBaas, multibaasEnabled, type MbBook } from './multibaas';
import { STATUS, type Book, type InvoiceRow } from './state';

type Send = (label: string, address: Address, abi: readonly unknown[], fn: string, args: unknown[]) => Promise<void>;
type Props = { dep: Deployment; s: Session; book: Book; send: Send };
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
  const cls = inv.frozen ? 'closed' : inv.status === 2 ? 'open' : inv.status === 4 ? 'open' : 'closed';
  return <span className={`badge ${cls}`}>{inv.frozen ? 'FROZEN' : STATUS[inv.status].toUpperCase()}</span>;
}

// ---------------------------------------------------------------- Supplier
export function SupplierPage({ dep, s, book, send }: Props) {
  const [debtor, setDebtor] = useState('');
  const [face, setFace] = useState('500000');
  const [days, setDays] = useState('60');
  const [docHash, setDocHash] = useState<`0x${string}`>();
  const [fileName, setFileName] = useState('');
  const mine = book.invoices.filter((i) => i.supplier.toLowerCase() === s.account.toLowerCase() || i.myTokens > 0n);
  return (
    <div className="grid">
      <section className="card">
        <h3>Register invoice (請求書)</h3>
        <p className="muted">{book.me.verified ? `Verified: ${book.me.name}` : 'Not KYB-verified — ask the operator.'}</p>
        <label className="field">
          <span>Invoice PDF (hashed locally, never uploaded)</span>
          <input
            type="file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFileName(f.name);
                setDocHash(await sha256File(f));
              }
            }}
          />
        </label>
        {docHash && <p className="muted mono">{fileName}: {short(docHash)}</p>}
        <F label="Debtor address (verified company)" value={debtor} set={setDebtor} ph="0x… debtor wallet" />
        <F label="Face value (JPYC)" value={face} set={setFace} />
        <F label="Days to maturity" value={days} set={setDays} />
        <p className="muted">
          Discount rate: not yours to choose. The curve uses the debtor's live credit rate (operator rating + on-chain payment history).
        </p>
        <button
          disabled={!isAddress(debtor)}
          onClick={() =>
            send('Register invoice', dep.registry, ABI.registry, 'registerInvoice', [
              debtor,
              u(face),
              BigInt(book.chainTime + Number(days) * 86400),
              docHash ?? keccak256(toBytes(`${debtor}-${face}-${days}-${Date.now()}`)),
            ])
          }
        >
          Register
        </button>
      </section>
      {mine.map((inv) => (
        <SellCard key={inv.id} inv={inv} dep={dep} book={book} send={send} />
      ))}
    </div>
  );
}

function SellCard({ inv, dep, book, send }: { inv: InvoiceRow; dep: Deployment; book: Book; send: Send }) {
  const [amt, setAmt] = useState('100000');
  const fairValue = (u(amt) * inv.fair) / 10n ** 18n;
  return (
    <section className="card">
      <h3>
        Invoice #{inv.id} <Badge inv={inv} />
      </h3>
      <p className="muted">
        {inv.debtorName || short(inv.debtor)} · face {yen(inv.face)} · due {jst(inv.maturity)}
      </p>
      <p>You hold {yen(inv.myTokens)} face in tokens</p>
      <p className="muted">Debtor grade {inv.debtorGrade} · rate {pct(inv.rateBps)} (at registration {pct(inv.rateAtIssueBps)})</p>
      {inv.status === 2 && inv.poolCreated && (
        <>
          <F label="Sell face amount" value={amt} set={setAmt} />
          <p className="muted">
            Fair value on curve: <b>{yen(fairValue)}</b> (price {price(inv.fair)}) · min out set to 98% of fair
          </p>
          <div className="row">
            <button className="ghost" onClick={() => send('Approve invoice token', inv.token, ABI.token, 'approve', [dep.market, MAX])}>Approve</button>
            <button onClick={() => send(`Sell invoice #${inv.id} for early cash`, dep.market, ABI.market, 'sell', [BigInt(inv.id), u(amt), (fairValue * 98n) / 100n, deadline(book)])}>
              Sell for JPYC now
            </button>
          </div>
        </>
      )}
      {(inv.status === 4 || inv.status === 5) && inv.myTokens > 0n && (
        <button onClick={() => send('Redeem', dep.registry, ABI.registry, 'redeem', [BigInt(inv.id), inv.myTokens])}>Redeem {yen(inv.myTokens)}</button>
      )}
      {inv.status === 1 && <p className="muted">Waiting for the debtor to accept.</p>}
      {book && null}
    </section>
  );
}

// ---------------------------------------------------------------- Debtor
export function DebtorPage({ dep, s, book, send }: Props) {
  const mine = book.invoices.filter((i) => i.debtor.toLowerCase() === s.account.toLowerCase());
  return (
    <div className="grid">
      <section className="card">
        <h3>Debtor: {book.me.name || short(s.account)}</h3>
        <p>JPYC balance {yen(book.me.jpyc)}</p>
        <button className="ghost" onClick={() => send('Approve JPYC for payments', dep.jpyc, ABI.jpyc, 'approve', [dep.registry, MAX])}>
          Approve JPYC for payments
        </button>
      </section>
      {mine.length === 0 && <p className="muted">No invoices addressed to you.</p>}
      {mine.map((inv) => (
        <section className="card" key={inv.id}>
          <h3>
            Invoice #{inv.id} <Badge inv={inv} />
          </h3>
          <p className="muted">from {inv.supplierName || short(inv.supplier)} · due {jst(inv.maturity)}</p>
          <p>
            Face {yen(inv.face)} · paid {yen(inv.funded)}
          </p>
          {inv.status === 1 && (
            <div className="row">
              <button onClick={() => send('Accept (発生記録)', dep.registry, ABI.registry, 'acceptInvoice', [BigInt(inv.id)])}>Accept</button>
              <button className="danger" onClick={() => send('Reject', dep.registry, ABI.registry, 'rejectInvoice', [BigInt(inv.id), 'disputed'])}>
                Reject
              </button>
            </div>
          )}
          {inv.status === 2 && (
            <button onClick={() => send('Pay invoice in JPYC', dep.registry, ABI.registry, 'pay', [BigInt(inv.id), inv.face - inv.funded])}>
              Pay {yen(inv.face - inv.funded)} JPYC
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Investor / market
export function InvestorPage({ dep, book, send }: Props) {
  const [bid, setBid] = useState('300000');
  const [buyAmt, setBuyAmt] = useState('50000');
  const [offset, setOffset] = useState('0');
  return (
    <div>
      <p className="muted">
        JPYC {yen(book.me.jpyc)} · curve band ±{String(book.bandBps)} bps ·{' '}
        <button className="ghost small" onClick={() => send('Approve JPYC for market', dep.jpyc, ABI.jpyc, 'approve', [dep.market, MAX])}>
          Approve JPYC
        </button>
      </p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Debtor</th>
            <th>Face</th>
            <th>Days</th>
            <th>Credit</th>
            <th>Fair (curve)</th>
            <th>Pool</th>
            <th>Dev</th>
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
                <td>{inv.id}</td>
                <td>{inv.debtorName || short(inv.debtor)}</td>
                <td>{yen(inv.face)}</td>
                <td>{d.toFixed(1)}</td>
                <td title={`rate at registration ${pct(inv.rateAtIssueBps)}`}>
                  G{inv.debtorGrade} · {pct(inv.rateBps)}
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
                    <button className="small" onClick={() => send('Create pool on curve', dep.market, ABI.market, 'createPool', [BigInt(inv.id)])}>Create pool</button>
                  )}
                  {inv.poolCreated && inv.tradable && (
                    <button
                      className="small"
                      onClick={() => send(`Post ${bid} JPYC bids`, dep.market, ABI.market, 'postBids', [BigInt(inv.id), u(bid), Number(offset), 150, deadline(book)])}
                    >
                      Post bids
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
                      Buy
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
        <F label="Bid offset below price (ticks, ×10)" value={offset} set={setOffset} />
        <F label="Buy size (JPYC)" value={buyAmt} set={setBuyAmt} />
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
  return (
    <div className="grid">
      <section className="card">
        <h3>KYB: verify company</h3>
        <p className="muted">
          {book.me.isOperator ? 'You hold OPERATOR_ROLE.' : 'You are not an operator.'} In production this key is a MultiBaas Cloud Wallet (HSM) —
          see multibaas/src/operator.ts.
        </p>
        <F label="Company wallet" value={who} set={setWho} ph="0x…" />
        <F label="法人番号 (corporate number)" value={corp} set={setCorp} ph="1010001000001" />
        <F label="Company name" value={name} set={setName} />
        <button disabled={!isAddress(who) || !corp} onClick={() => send('Verify company', dep.registry, ABI.registry, 'verifyCompany', [who, keccak256(toBytes(`corp:${corp}`)), name])}>
          Verify
        </button>
      </section>
      <section className="card">
        <h3>Credit: rate debtor</h3>
        <p className="muted">
          rate = base {pct(book.baseRateBps)} + grade spread (G1 1% · G2 2% · G3 4% · G4 8% · G5 16%) + 10% per default + 1% per late payment − 0.1% per
          on-time settlement (max 1%). Re-rating reprices every open invoice of the debtor.
        </p>
        <F label="Debtor wallet" value={debtor} set={setDebtor} ph="0x…" />
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
        <h3>Freeze / unfreeze invoice</h3>
        <F label="Invoice id" value={id} set={setId} />
        <div className="row">
          <button className="danger" onClick={() => send('Freeze', dep.registry, ABI.registry, 'setFrozen', [BigInt(id || '0'), true])}>Freeze</button>
          <button className="ghost" onClick={() => send('Unfreeze', dep.registry, ABI.registry, 'setFrozen', [BigInt(id || '0'), false])}>Unfreeze</button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Receivables book (dashboard)
export function BookPage({ book }: Props) {
  const [mb, setMb] = useState<MbBook>();
  const [mbErr, setMbErr] = useState<string>();
  useEffect(() => {
    if (multibaasEnabled) fetchBookFromMultiBaas().then(setMb).catch((e) => setMbErr(String(e?.message ?? e)));
  }, [book.chainTime]);

  const active = book.invoices.filter((i) => i.status === 2);
  const outstanding = active.reduce((a, i) => a + (i.face - i.funded), 0n);
  const byDebtor = new Map<string, bigint>();
  for (const i of active) byDebtor.set(i.debtorName || i.debtor, (byDebtor.get(i.debtorName || i.debtor) ?? 0n) + (i.face - i.funded));
  const ladder = [30, 60, 90, 180].map((d, k, arr) => {
    const lo = k === 0 ? 0 : arr[k - 1];
    const sum = active.filter((i) => daysLeft(i, book.chainTime) > lo && daysLeft(i, book.chainTime) <= d).reduce((a, i) => a + (i.face - i.funded), 0n);
    return { label: `${lo}–${d}d`, sum };
  });
  return (
    <div className="grid">
      <section className="card">
        <h3>Receivables book</h3>
        <p className="big">{yen(outstanding)}</p>
        <p className="muted">outstanding across {active.length} active invoices</p>
        <p className="muted">
          Source: {multibaasEnabled ? (mbErr ? `MultiBaas error — ${mbErr}` : 'MultiBaas Event Queries') : 'direct RPC (set VITE_MB_BASE_URL/VITE_MB_API_KEY for MultiBaas)'}
        </p>
      </section>
      <section className="card">
        <h3>Outstanding by debtor</h3>
        {[...byDebtor].map(([d, v]) => (
          <p key={d}>
            {d.length > 30 ? short(d) : d}: <b>{yen(v)}</b>
          </p>
        ))}
      </section>
      <section className="card">
        <h3>Maturity ladder</h3>
        {ladder.map((l) => (
          <div key={l.label} className="ladder">
            <span>{l.label}</span>
            <div className="bar" style={{ width: `${outstanding === 0n ? 0 : Number((l.sum * 100n) / outstanding)}%` }} />
            <span>{yen(l.sum)}</span>
          </div>
        ))}
      </section>
      <section className="card">
        <h3>Status</h3>
        {STATUS.slice(1).map((st, k) => (
          <p key={st}>
            {st}: <b>{book.invoices.filter((i) => i.status === k + 1).length}</b>
          </p>
        ))}
      </section>
      {mb && (
        <section className="card">
          <h3>MultiBaas-indexed credit events</h3>
          {mb.credit.length === 0 && <p className="muted">none yet</p>}
          {mb.credit.map((c, k) => (
            <p key={k} className="mono">
              {short(String(c.debtor))} {c.grade != null ? `rated G${c.grade}` : ['on-time', 'late', 'DEFAULT'][Number(c.kind)]} → {Number(c.rate_bps) / 100}% · {c.at}
            </p>
          ))}
        </section>
      )}
      {mb && (
        <section className="card">
          <h3>MultiBaas-indexed curve trades</h3>
          {mb.trades.map((t, k) => (
            <p key={k} className="mono">
              #{t.id} price {price(BigInt(String(t.price)))} fair {price(BigInt(String(t.fair)))} · {t.at}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
