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
const gradeLabel = (grade: number, rated: boolean) => (rated ? `G${grade}` : `G${grade} (unrated)`);
/// Company names are self-declared: only an operator rating says anything about who a company is.
const company = (name: string, addr: string, rated: boolean) => `${name || short(addr)}${rated ? ' ✓ rated' : ' · unverified'}`;
const GRADES = [0, 1, 2, 3, 4, 5];
const gradeName = (g: number) => (g === 0 ? 'Unrated' : `G${g}`);

/// Self-declared company name (not verified): shown on invoices and in their on-chain record.
function CompanyName({ dep, s, book, send }: Props) {
  const [name, setName] = useState('');
  return (
    <>
      <p className="muted">
        {book.me.name ? `Company: ${book.me.name} (self-declared, unique)` : `No company name set for ${short(s.account)}.`}
      </p>
      <div className="row">
        <F label="Company name" value={name} set={setName} ph={book.me.name || '株式会社… (shown on your invoices)'} />
        <button className="ghost" disabled={!name.trim()} onClick={() => send('Set company name', dep.registry, ABI.registry, 'setCompanyName', [name.trim()])}>
          Save name
        </button>
      </div>
    </>
  );
}

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
  const [ref, setRef] = useState('');
  const mine = book.invoices.filter((i) => i.supplier.toLowerCase() === s.account.toLowerCase() || i.myTokens > 0n);
  return (
    <div className="grid">
      <section className="card">
        <h3>Register invoice (請求書)</h3>
        <CompanyName dep={dep} s={s} book={book} send={send} />
        <label className="field">
          <span>Invoice PDF (hashed locally, never uploaded)</span>
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
        <F label="Debtor address" value={debtor} set={setDebtor} ph="0x… debtor wallet" />
        <F label="Face value (JPYC)" value={face} set={setFace} />
        <F label="Days to maturity" value={days} set={setDays} />
        <p className="muted">
          Discount rate: not yours to choose. The curve uses the debtor's live credit rate (operator rating + on-chain payment history). A debtor the
          operator hasn't rated is priced as the weakest grade, G5. You can always register an invoice;{' '}
          {book.requiredByGrade[0] > 0
            ? `an unrated debtor must lock ${book.requiredByGrade[0] / 100}% collateral before it can accept.`
            : 'no collateral is needed for the debtor to accept.'}
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
          Register
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
        {company(inv.debtorName, inv.debtor, inv.debtorRated)} · face {yen(inv.face)} · due {jst(inv.maturity)}
      </p>
      <InvoiceRecord inv={inv} s={s} />
      <p>You hold {yen(inv.myTokens)} face in tokens</p>
      <p className="muted">Debtor grade {gradeLabel(inv.debtorGrade, inv.debtorRated)} · rate {pct(inv.rateBps)} (at registration {pct(inv.rateAtIssueBps)})</p>
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

/// The invoice's real-world details, read from chain: InvoiceToken.contractURI() (ERC-7572 JSON built by the registry).
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
      <summary className="muted small-text">On-chain invoice record (contractURI)</summary>
      <pre className="mono">{json ?? 'loading…'}</pre>
    </details>
  );
}

// ---------------------------------------------------------------- Debtor
export function DebtorPage({ dep, s, book, send }: Props) {
  const mine = book.invoices.filter((i) => i.debtor.toLowerCase() === s.account.toLowerCase());
  const [amt, setAmt] = useState('20000');
  const [preview, setPreview] = useState('500000');
  const m = book.me;
  const share = (m.requiredBps / 100).toFixed(0);
  const previewNeed = (u(preview) * BigInt(m.requiredBps)) / 10_000n;
  return (
    <div className="grid">
      <section className="card">
        <h3>Debtor: {book.me.name || short(s.account)}</h3>
        <CompanyName dep={dep} s={s} book={book} send={send} />
        <p>JPYC balance {yen(book.me.jpyc)}</p>
        <button className="ghost" onClick={() => send('Approve JPYC for payments', dep.jpyc, ABI.jpyc, 'approve', [dep.registry, MAX])}>
          Approve JPYC for payments
        </button>
      </section>
      <section className="card">
        <h3>Collateral (担保)</h3>
        <p className="muted">
          {m.rated ? `Grade G${m.grade}` : `Unrated: priced as G${m.grade} until the operator rates you`} —{' '}
          {m.requiredBps > 0 ? `to accept an invoice you must hold collateral covering ${share}% of everything you will owe.` : 'collateral is optional.'} Collateral
          backing your accepted invoices stays locked until they are paid, lowers your rate by up to 2% (at 100% coverage) and earns {pct(book.aprBps)} APR.
        </p>
        <p>
          Owed (accepted) {yen(m.outstanding)} · deposited <b>{yen(m.collateral)}</b> · locked {yen(m.locked)} · free {yen(m.collateral - m.locked)} · coverage{' '}
          {(m.coverageBps / 100).toFixed(0)}%
        </p>
        {m.requiredBps > 0 && (
          <div className="row">
            <F label="Next invoice face (JPYC)" value={preview} set={setPreview} />
            <p className="muted">
              To accept an invoice of {yen(u(preview))}, hold at least <b>{yen(m.collateralRequired + previewNeed)}</b> in total ({share}% of {yen(m.outstanding + u(preview))}{' '}
              owed).
            </p>
          </div>
        )}
        <F label="Amount (JPYC)" value={amt} set={setAmt} />
        <div className="row">
          {m.jpycAllowanceVault < u(amt) && (
            <button className="ghost" onClick={() => send('Approve JPYC for collateral', dep.jpyc, ABI.jpyc, 'approve', [dep.vault, MAX])}>Approve</button>
          )}
          <button onClick={() => send(`Lock ${amt} JPYC collateral`, dep.vault, ABI.vault, 'deposit', [u(amt)])}>Lock collateral</button>
          <button className="ghost" onClick={() => send(`Withdraw ${amt} JPYC collateral`, dep.vault, ABI.vault, 'withdraw', [u(amt)])}>Withdraw</button>
        </div>
        <p className="muted small-text">If an invoice defaults, locked collateral is paid to its holders automatically.</p>
      </section>
      <section className="card">
        <h3>Collateral interest</h3>
        <p>
          Earning <b>{pct(book.aprBps)}</b> APR on {yen(m.stake)} · accrued <b>{yen(m.interest)}</b>
        </p>
        <p className="muted">
          Only collateral that backs your accepted, unpaid invoices earns interest. Paid in JPYC from the platform's reward pool ({yen(book.rewardReserve)} left); if the
          pool runs short you get what it holds and the rest stays claimable.
        </p>
        <button disabled={m.interest === 0n || book.rewardReserve === 0n} onClick={() => send('Claim collateral interest', dep.vault, ABI.vault, 'claimInterest', [])}>
          Claim {yen(m.interest < book.rewardReserve ? m.interest : book.rewardReserve)}
        </button>
      </section>
      {mine.length === 0 && <p className="muted">No invoices addressed to you.</p>}
      {mine.map((inv) => (
        <section className="card" key={inv.id}>
          <h3>
            Invoice #{inv.id} <span className="mono muted">{inv.ref}</span> <Badge inv={inv} />
          </h3>
          <p className="muted">from {company(inv.supplierName, inv.supplier, inv.supplierRated)} · due {jst(inv.maturity)}</p>
          <p>
            Face {yen(inv.face)} · paid {yen(inv.funded)}
          </p>
          {inv.status === 1 && inv.acceptNeed > m.collateral && (
            <p className="muted">
              To accept, hold {yen(inv.acceptNeed)} of collateral: lock <b>{yen(inv.acceptNeed - m.collateral)}</b> more above.
            </p>
          )}
          {inv.status === 1 && (
            <div className="row">
              <button disabled={inv.acceptNeed > m.collateral} onClick={() => send('Accept (発生記録)', dep.registry, ABI.registry, 'acceptInvoice', [BigInt(inv.id)])}>
                Accept
              </button>
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
export function InvestorPage({ dep, s, book, send }: Props) {
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
            // Only an accepted invoice trades on its curve. Once settled/defaulted it is worth its redemption value
            // (1:1, or pro-rata of what was paid in), and pool price / deviation / yield no longer mean anything.
            const open = inv.status === 1 || inv.status === 2;
            const trading = inv.status === 2;
            const value =
              inv.status === 4 ? 10n ** 18n : inv.status === 5 ? (inv.funded * 10n ** 18n) / inv.face : open ? inv.fair : undefined;
            return (
              <tr key={inv.id}>
                <td>
                  {inv.id} <div className="mono muted small-text">{inv.ref}</div>
                </td>
                <td>{company(inv.debtorName, inv.debtor, inv.debtorRated)}</td>
                <td>{yen(inv.face)}</td>
                <td>{open ? d.toFixed(1) : '—'}</td>
                <td title={`rate at registration ${pct(inv.rateAtIssueBps)}`}>
                  {gradeLabel(inv.debtorGrade, inv.debtorRated)} · {pct(inv.rateBps)}
                  {inv.debtorCoverageBps > 0 && <div className="muted small-text">🔒 {(inv.debtorCoverageBps / 100).toFixed(0)}% collateral</div>}
                </td>
                <td title={open ? 'fair value on the curve' : 'redemption value per ¥1 of face'}>
                  {value === undefined ? '—' : price(value)}
                  {!open && value !== undefined && <div className="muted small-text">redeem</div>}
                </td>
                <td>{trading && inv.poolPrice ? price(inv.poolPrice) : '—'}</td>
                <td>{trading && inv.deviationBps !== undefined ? `${inv.deviationBps} bps` : '—'}</td>
                <td>{!open ? '—' : trading && inv.poolPrice ? `${impliedYield(inv.poolPrice, d).toFixed(2)}%` : pct(inv.rateBps)}</td>
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
  const [id, setId] = useState('1');
  const [debtor, setDebtor] = useState('');
  const [grade, setGrade] = useState('2');
  const [base, setBase] = useState('');
  const [apr, setApr] = useState('');
  const [fund, setFund] = useState('100000');
  const [reqGrade, setReqGrade] = useState('0');
  const [reqBps, setReqBps] = useState('');
  return (
    <div className="grid">
      <section className="card">
        <h3>Credit: rate debtor</h3>
        <p className="muted">
          {book.me.isOperator ? 'You hold OPERATOR_ROLE.' : 'You are not an operator.'} rate = base {pct(book.baseRateBps)} + grade spread (G1 1% · G2 2% · G3 4% ·
          G4 8% · G5 16%) + 10% per default + 1% per late payment − 0.1% per on-time settlement (max 1%) − up to 2% for collateral. Unrated debtors are priced as G5.
          Re-rating reprices every open invoice of the debtor.
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
        <h3>Collateral interest</h3>
        <p className="muted">
          Debtors earn <b>{pct(book.aprBps)}</b> APR on locked collateral, paid from the reward pool: <b>{yen(book.rewardReserve)}</b>. Anyone can fund the pool; only
          the operator sets the APR (max 20%) or withdraws unused funds.
        </p>
        <F label="APR (bps)" value={apr} set={setApr} ph={String(book.aprBps)} />
        <button className="ghost" disabled={!apr} onClick={() => send(`Set collateral APR to ${apr} bps`, dep.vault, ABI.vault, 'setAprBps', [Number(apr)])}>Set APR</button>
        <F label="Amount (JPYC)" value={fund} set={setFund} />
        <div className="row">
          {book.me.jpycAllowanceVault < u(fund) && (
            <button className="ghost" onClick={() => send('Approve JPYC for the reward pool', dep.jpyc, ABI.jpyc, 'approve', [dep.vault, MAX])}>Approve</button>
          )}
          <button onClick={() => send(`Fund reward pool with ${fund} JPYC`, dep.vault, ABI.vault, 'fundRewards', [u(fund)])}>Fund pool</button>
          <button className="ghost" onClick={() => send(`Withdraw ${fund} JPYC from the reward pool`, dep.vault, ABI.vault, 'withdrawRewards', [u(fund)])}>Withdraw</button>
        </div>
      </section>
      <section className="card">
        <h3>Collateral requirement</h3>
        <p className="muted">
          Collateral a debtor must hold to ACCEPT an invoice, as a share of everything it will owe:{' '}
          {GRADES.map((g) => `${gradeName(g)} ${book.requiredByGrade[g] / 100}%`).join(' · ')}. Registration is never blocked. At 0% collateral is optional.
        </p>
        <label className="field">
          <span>Grade</span>
          <select value={reqGrade} onChange={(e) => setReqGrade(e.target.value)}>
            {GRADES.map((g) => (<option key={g} value={g}>{gradeName(g)}</option>))}
          </select>
        </label>
        <F label="Required (bps of outstanding, 0 = optional)" value={reqBps} set={setReqBps} ph={String(book.requiredByGrade[Number(reqGrade)])} />
        <button className="ghost" disabled={reqBps === ''} onClick={() => send(`Require ${reqBps} bps collateral for ${gradeName(Number(reqGrade))}`, dep.vault, ABI.vault, 'setRequiredBps', [Number(reqGrade), Number(reqBps)])}>
          Set requirement
        </button>
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
