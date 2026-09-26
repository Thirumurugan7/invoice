import { useEffect, useRef, useState } from 'react';
import { isAddress, parseUnits, type Address } from 'viem';
import { ABI, sha256File, type Deployment, type Session } from './chain';
import { jst, price, short, yen } from './errors';
import { fetchBookFromMultiBaas, multibaasEnabled, type MbBook } from './multibaas';
import { STATUS, type Book, type InvoiceRow } from './state';

type Send = (label: string, address: Address, abi: readonly unknown[], fn: string, args: unknown[]) => Promise<void>;
type Props = { dep: Deployment; s: Session; book: Book; send: Send; onViewAll?: () => void; isConsumer?: boolean };
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

function CompanyName({ dep, book, send }: Props) {
  const [name, setName] = useState('');
  return (
    <div className="company-name-control">
      <p className="muted">{book.me.name ? `Company: ${book.me.name}` : 'Add a unique display name for on-chain invoice records.'}</p>
      <div className="row">
        <F label="Company name" value={name} set={setName} ph={book.me.name || '株式会社…'} />
        <button className="ghost" disabled={!name.trim()} onClick={() => send('Set company name', dep.registry, ABI.registry, 'setCompanyName', [name.trim()])}>Save name</button>
      </div>
    </div>
  );
}

export function SupplierPage({ dep, s, book, send, isConsumer }: Props) {
  const [debtor, setDebtor] = useState('');
  const [face, setFace] = useState('500000');
  const [days, setDays] = useState('60');
  const [docHash, setDocHash] = useState<`0x${string}`>();
  const [fileName, setFileName] = useState('');
  const [ref, setRef] = useState('');
  const [documentError, setDocumentError] = useState<string>();
  const mine = book.invoices.filter((i) => i.supplier.toLowerCase() === s.account.toLowerCase() || i.myTokens > 0n);
  const registered = mine.find((invoice) => invoice.ref === ref);
  const validFace = Number(face) > 0 && Number(face) <= 1_000_000_000_000;
  const validDays = Number.isInteger(Number(days)) && Number(days) >= 1;
  const ready = Boolean(docHash && ref.trim() && isAddress(debtor) && debtor.toLowerCase() !== s.account.toLowerCase() && validFace && validDays && !registered);
  const prefillFromDocument = (text: string) => {
    const reference = text.match(/(?:invoice|reference|invoice\s*(?:number|no\.?|#))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/i)?.[1];
    const wallet = text.match(/0x[a-fA-F0-9]{40}/)?.[0];
    const amount = text.match(/(?:face\s*value|total|amount\s*due|invoice\s*amount)\s*[:¥$]?\s*(?:JPY|JPYC)?\s*([0-9][0-9,]*)/i)?.[1];
    const due = text.match(/(?:due\s*date|payment\s*due|maturity)\s*[:\s]+(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i)?.[1];
    if (reference && !ref) setRef(reference);
    if (wallet && !debtor) setDebtor(wallet);
    if (amount) setFace(amount.replace(/,/g, ''));
    if (due) {
      const dueTime = new Date(`${due.replaceAll('/', '-')}T00:00:00+09:00`).getTime() / 1000;
      if (Number.isFinite(dueTime)) setDays(String(Math.max(7, Math.ceil((dueTime - book.chainTime) / 86400))));
    }
  };
  return (
    <div className="grid">
      <section className="card invoice-intake">
        <h3>Upload invoice for liquidity</h3>
        <CompanyName dep={dep} s={s} book={book} send={send} />
        <label className="field">
          <span>Invoice PDF</span>
          <input
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setDocumentError(undefined);
                setFileName(f.name);
                if (!ref) setRef(f.name.replace(/\.[^.]+$/, '').replace(/^invoice-/i, ''));
                try {
                  const [hash, text] = await Promise.all([sha256File(f), readAssistantAttachment(f)]);
                  setDocHash(hash);
                  prefillFromDocument(text);
                } catch (error: any) {
                  setDocHash(undefined);
                  setDocumentError(String(error?.message ?? 'Could not read this invoice.'));
                }
              }
            }}
          />
        </label>
        {docHash && <p className="muted mono">{fileName}: {short(docHash)}</p>}
        {documentError && <p className="attachment-error" role="alert">{documentError}</p>}
        <F label="Invoice number (請求書番号)" value={ref} set={setRef} ph="SKR-2026-0926-001" />
        <F label="Buyer company wallet" value={debtor} set={setDebtor} ph="0x… approved company" />
        <F label="Face value (JPYC)" value={face} set={setFace} />
        <F label="Days to maturity" value={days} set={setDays} />
        {isAddress(debtor) && debtor.toLowerCase() === s.account.toLowerCase() && <p className="form-warning">Supplier and buyer must use different wallets.</p>}
        {!validFace && <p className="form-warning">Face value must be above zero and no more than ¥1 trillion.</p>}
        {!validDays && <p className="form-warning">Maturity must be at least 1 day from registration.</p>}
        <button
          disabled={!ready}
          onClick={() => send('Register invoice on-chain', dep.registry, ABI.registry, 'registerInvoice', [
              debtor,
              u(face),
              BigInt(book.chainTime + Number(days) * 86400),
              docHash!,
              ref.trim(),
            ])}
        >
          Register invoice on-chain
        </button>
        <div className="invoice-process" aria-label="Invoice funding process">
          <div className={docHash ? 'complete' : 'current'}><b>1</b><span>Document verified<small>PDF hashed locally</small></span></div>
          <div className={registered ? 'complete' : docHash ? 'current' : ''}><b>2</b><span>On-chain registration<small>Wallet confirmation required</small></span></div>
          <div className={registered?.status && registered.status >= 2 ? 'complete' : registered ? 'current' : ''}><b>3</b><span>Buyer approval<small>{registered?.status === 1 ? 'Awaiting buyer' : 'Required before funding'}</small></span></div>
          <div className={registered?.poolCreated ? 'complete' : registered?.status === 2 ? 'current' : ''}><b>4</b><span>Investor market<small>Pool and bids open</small></span></div>
          <div className={registered && registered.funded > 0n ? 'complete' : registered?.poolCreated ? 'current' : ''}><b>5</b><span>Funding and settlement<small>Tracked until maturity</small></span></div>
        </div>
      </section>
      {mine.map((inv) => (
        <SellCard key={inv.id} inv={inv} dep={dep} book={book} send={send} s={s} isConsumer={isConsumer} />
      ))}
    </div>
  );
}

/// Consumer Finance sells into the same investor market as any supplier — same `market.sell`, same investor bids
/// and approval — but capped to what their World ID Selfie Check score unlocks, not the full face value. A regular
/// seller account is unaffected: full face value, no World ID involved.
function useWorldCap({ gated, s, myTokens }: { gated: boolean; s: Session; myTokens: bigint }) {
  const [verification, setVerification] = useState<{ score: number } | null>();
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    if (!gated) return;
    let live = true;
    fetch(`/api/world/status?address=${s.account}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((result) => {
        if (!live) return;
        setConfigured(Boolean(result.configured));
        setVerification(result.verification ?? null);
      })
      .catch(() => live && setConfigured(false));
    return () => { live = false; };
  }, [gated, s.account]);
  if (!gated || !configured) return { gated: false, verified: true, scorePercent: 100, cap: myTokens };
  const scorePercent = verification ? Math.max(0, Math.min(100, verification.score <= 10 ? verification.score * 10 : verification.score)) : 0;
  return { gated: true, verified: Boolean(verification), scorePercent, cap: (myTokens * BigInt(scorePercent)) / 100n };
}

function SellCard({ inv, dep, book, send, s, isConsumer }: { inv: InvoiceRow; dep: Deployment; book: Book; send: Send; s: Session; isConsumer?: boolean }) {
  const [amt, setAmt] = useState('100000');
  const fairValue = (u(amt) * inv.fair) / 10n ** 18n;
  const worldCap = useWorldCap({ gated: Boolean(isConsumer), s, myTokens: inv.myTokens });
  const overCap = worldCap.gated && u(amt) > worldCap.cap;
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
      {worldCap.gated && inv.status === 2 && inv.poolCreated && inv.myTokens > 0n && (
        <p className="muted small-text">
          {worldCap.verified
            ? `Your World ID Selfie Check score unlocks ${worldCap.scorePercent}% of this invoice now (${yen(worldCap.cap)} of ${yen(inv.myTokens)}); the rest releases when ${inv.debtorName || 'the buyer'} pays.`
            : 'Verify with World ID on the Consumer Finance dashboard to unlock early access to this invoice.'}
        </p>
      )}
      <p className="muted">Buyer grade G{inv.debtorGrade}{inv.debtorRated ? '' : ' (unrated)'} · pricing rate {pct(inv.rateBps)} (at upload {pct(inv.rateAtIssueBps)})</p>
      {inv.status === 2 && inv.poolCreated && (worldCap.verified || !worldCap.gated) && (
        <>
          <F label="Sell face amount" value={amt} set={setAmt} />
          <p className="muted">
            Indicative liquidity: <b>{yen(fairValue)}</b> (price {price(inv.fair)}) · minimum proceeds set to 98%
          </p>
          {overCap && <p className="form-warning">That's above the {yen(worldCap.cap)} your Selfie Check score unlocks right now.</p>}
          <div className="row">
            <button className="ghost" onClick={() => send('Approve invoice token', inv.token, ABI.token, 'approve', [dep.market, MAX])}>Approve</button>
            <button disabled={overCap} onClick={() => send(`Sell invoice #${inv.id} for early cash`, dep.market, ABI.market, 'sell', [BigInt(inv.id), u(amt), (fairValue * 98n) / 100n, deadline(book)])}>
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
  return (
    <div className="grid">
      <section className="card">
        <h3>Invoice approvals</h3>
        <CompanyName dep={dep} s={s} book={book} send={send} />
        <p>{book.me.name || short(s.account)} · payment balance {yen(book.me.jpyc)}</p>
        <button className="ghost" onClick={() => send('Approve JPYC for payments', dep.jpyc, ABI.jpyc, 'approve', [dep.registry, MAX])}>
          Approve settlement account
        </button>
      </section>
      <section className="card">
        <h3>Settlement reserve</h3>
        <p className="muted">
          {m.rated ? `Grade G${m.grade}` : 'Unrated'} · acceptance requires {(m.requiredBps / 100).toFixed(0)}% collateral. Locked collateral earns {pct(book.aprBps)} APR while backing accepted invoices.
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
        <p className="muted small-text">Locked {yen(m.locked)} · earning interest {yen(m.stake)} · accrued {yen(m.interest)}</p>
        <button disabled={m.interest === 0n || book.rewardReserve === 0n} onClick={() => send('Claim collateral interest', dep.vault, ABI.vault, 'claimInterest', [])}>Claim interest</button>
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
              <button disabled={m.collateral < inv.acceptNeed} onClick={() => send('Accept (発生記録)', dep.registry, ABI.registry, 'acceptInvoice', [BigInt(inv.id)])}>Approve invoice</button>
              <button className="danger" onClick={() => send('Reject', dep.registry, ABI.registry, 'rejectInvoice', [BigInt(inv.id), 'disputed'])}>
                Reject
              </button>
              {m.collateral < inv.acceptNeed && <span className="form-warning">Reserve {yen(inv.acceptNeed - m.collateral)} more before approval.</span>}
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
        <h3>Collateral policy and rewards</h3>
        <p className="muted">Unrated wallets use grade 0. Requirements are enforced when the buyer accepts, never when the supplier registers.</p>
        <label className="field"><span>Risk band</span><select value={reqGrade} onChange={(event) => setReqGrade(event.target.value)}><option value="0">Unrated</option>{[1,2,3,4,5].map((g) => <option key={g} value={g}>G{g}</option>)}</select></label>
        <F label="Required collateral (bps)" value={reqBps} set={setReqBps} ph={String(book.requiredByGrade[Number(reqGrade)])} />
        <button className="ghost" disabled={reqBps === ''} onClick={() => send('Set collateral requirement', dep.vault, ABI.vault, 'setRequiredBps', [Number(reqGrade), Number(reqBps)])}>Set requirement</button>
        <F label="Collateral APR (bps)" value={apr} set={setApr} ph={String(book.aprBps)} />
        <button className="ghost" disabled={!apr} onClick={() => send('Set collateral APR', dep.vault, ABI.vault, 'setAprBps', [Number(apr)])}>Set APR</button>
        <F label="Reward reserve amount" value={fund} set={setFund} />
        <div className="row"><button onClick={() => send('Fund collateral rewards', dep.vault, ABI.vault, 'fundRewards', [u(fund)])}>Fund rewards</button><button className="ghost" onClick={() => send('Withdraw unused rewards', dep.vault, ABI.vault, 'withdrawRewards', [u(fund)])}>Withdraw rewards</button></div>
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
    { label: 'Market access', value: 'Open', tone: 'mint' },
    { label: 'Credit rating', value: book.me.rated ? `G${book.me.grade}` : 'Unrated', tone: book.me.rated ? 'mint' : 'butter' },
    { label: 'Delegated signing', value: book.me.isOperator ? 'Operator enabled' : 'Policy controlled', tone: book.me.isOperator ? 'ink' : 'lilac' },
    { label: 'Collateral requirement', value: pct(book.me.requiredBps), tone: book.me.requiredBps > 0 ? 'butter' : 'mint' },
  ];
  return (
    <div className="grid">
      <section className="hero permissions-hero">
        <span className="tag">Wallet & permissions</span>
        <span className="figure">Ready</span>
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

const CALENDAR_DAYS = 17;

type WorkflowContext = {
  key: string;
  invoiceId: string;
  reference: string;
  stage: string;
  status: string;
  supplier: string;
  buyer: string;
  buyerGrade: string;
  faceValue: string;
  funded: string;
  dueDate: string;
};

const workflowPrompt = (item: WorkflowContext) => [
  `Review invoice #${item.invoiceId} (${item.reference}) at the "${item.stage}" stage.`,
  `Status: ${item.status}`,
  `Supplier: ${item.supplier}`,
  `Buyer: ${item.buyer} (${item.buyerGrade})`,
  `Face value: ${item.faceValue}`,
  `Funded: ${item.funded}`,
  `Due date: ${item.dueDate}`,
  '',
  'Return only valid JSON with this exact shape:',
  '{"nextAction":"one specific action starting with a verb","urgency":"Now|Today|This week","risk":"the single most important risk or blocker","reason":"one short evidence-based reason","owner":"the team or role that should act"}',
  'Keep every value concise and practical for a finance operator. Do not include markdown or additional keys.',
].join('\n');

function invoiceWorkflowContext(invoice: InvoiceRow, book: Book, stage: string, status: string): WorkflowContext {
  return {
    key: `invoice-${invoice.id}`,
    invoiceId: String(invoice.id),
    reference: invoice.ref || 'No reference',
    stage,
    status,
    supplier: invoice.supplierName || short(invoice.supplier),
    buyer: invoice.debtorName || short(invoice.debtor),
    buyerGrade: `Grade ${invoice.debtorGrade}`,
    faceValue: yen(invoice.face),
    funded: yen(invoice.funded),
    dueDate: jst(invoice.maturity),
  };
}

function MaturityBoard({ book, selected, onSelect }: { book: Book; selected?: WorkflowContext; onSelect: (item: WorkflowContext) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<'open' | 'pending' | 'funded' | 'review'>('open');
  const [anchorDate, setAnchorDate] = useState(() => new Date(book.chainTime * 1000).toISOString().slice(0, 10));
  const open = book.invoices.filter((i) => i.status === 1 || i.status === 2);
  const visibleInvoices = open
    .filter((invoice) => filter === 'open'
      || (filter === 'pending' && invoice.status === 1)
      || (filter === 'funded' && invoice.status === 2 && invoice.funded > 0n)
      || (filter === 'review' && invoice.frozen))
    .sort((a, b) => a.maturity - b.maturity);
  const anchorTime = Math.floor(new Date(`${anchorDate}T00:00:00+09:00`).getTime() / 1000);
  const latestDue = visibleInvoices.reduce((latest, invoice) => Math.max(latest, invoice.maturity), anchorTime);
  const expandedDays = Math.min(90, Math.max(30, Math.ceil((latestDue - anchorTime) / 86400) + 9));
  const columnCount = showAll ? expandedDays : CALENDAR_DAYS;
  const startTime = anchorTime - 7 * 86400;
  const todayIndex = Math.round((book.chainTime - startTime) / 86400);
  const calendar = Array.from({ length: columnCount }, (_, index) => {
    const timestamp = startTime + index * 86400;
    const date = new Date(timestamp * 1000);
    return {
      index,
      day: date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', day: 'numeric' }),
      weekday: date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' }),
      weekend: ['Sat', 'Sun'].includes(date.toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' })),
    };
  });
  const lanes = visibleInvoices.map((invoice) => {
    const dueIndex = Math.round((invoice.maturity - startTime) / 86400);
    const funding = invoice.face > 0n ? Number((invoice.funded * 100n) / invoice.face) : 0;
    const isOverdue = invoice.maturity < book.chainTime;
    return {
      key: `invoice-${invoice.id}`,
      invoice,
      name: invoice.debtorName || short(invoice.debtor),
      meta: `#${invoice.id} · ${yen(invoice.face)}`,
      initial: String(invoice.id),
      start: Math.max(0, Math.min(columnCount - 1, todayIndex)),
      end: Math.max(0, Math.min(columnCount - 1, Math.max(todayIndex, dueIndex))),
      tone: invoice.frozen ? 'purple' : invoice.status === 1 ? 'blue' : 'green',
      label: invoice.frozen ? 'Under review' : invoice.status === 1 ? 'Awaiting buyer approval' : funding > 0 ? `${funding}% funded` : 'Open for investor bids',
      status: isOverdue ? 'Overdue' : `${Math.max(0, Math.ceil((invoice.maturity - book.chainTime) / 86400))}d to due`,
    };
  });
  const contextFor = (lane: typeof lanes[number]) => invoiceWorkflowContext(lane.invoice, book, lane.label, lane.status);

  return (
    <section className="panel schedule-panel">
      <div className="schedule-panel-head">
        <div>
          <h2>Invoice liquidity calendar</h2>
          <span>Live open invoices</span>
        </div>
        <div className="schedule-controls">
          <input
            className="calendar-date"
            type="date"
            aria-label="Calendar start date"
            value={anchorDate}
            onChange={(event) => setAnchorDate(event.target.value)}
          />
          <select className="calendar-filter" aria-label="Filter calendar invoices" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="open">All open</option>
            <option value="pending">Pending approval</option>
            <option value="funded">Funded</option>
            <option value="review">Under review</option>
          </select>
          <button className="ghost" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Compact view' : 'View all'}</button>
        </div>
      </div>
      {visibleInvoices.length === 0 ? (
        <p className="empty-state">No invoices match this calendar filter.</p>
      ) : (
        <div className="schedule-scroll" aria-label="Invoice liquidity calendar">
          <div className="schedule" style={{ ['--calendar-days' as any]: columnCount }}>
            <div className="schedule-corner">Invoices</div>
            <div className="schedule-dates">
              {calendar.map((date) => (
                <div className={`${date.weekend ? 'weekend ' : ''}${date.index === todayIndex ? 'today' : ''}`} key={date.index}>
                  <span>{date.weekday}</span><b>{date.day}</b>
                </div>
              ))}
            </div>
            {lanes.map((lane) => (
                <div className="schedule-row" key={lane.key}>
                  <div className="schedule-who">
                    <span className={`invoice-avatar ${lane.tone}`}>{lane.initial}</span>
                    <span><b>{lane.name}</b><small>{lane.meta}</small></span>
                  </div>
                  <div className="schedule-track">
                    {calendar.map((date) => <i className={date.weekend ? 'weekend' : ''} key={date.index} />)}
                    <div
                      className={`schedule-event ${lane.tone}${selected?.key === lane.key ? ' selected' : ''}`}
                      style={{ gridColumn: `${lane.start + 1} / ${lane.end + 2}` }}
                      role="button"
                      tabIndex={0}
                      draggable
                      aria-label={`${lane.label}, ${lane.status}. Click to review or drag to the AI operations desk.`}
                      onClick={() => onSelect(contextFor(lane))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(contextFor(lane));
                        }
                      }}
                      onDragStart={(event) => {
                        const item = contextFor(lane);
                        event.dataTransfer.effectAllowed = 'copy';
                        event.dataTransfer.setData('application/x-invoice-workflow', JSON.stringify(item));
                        event.dataTransfer.setData('text/plain', workflowPrompt(item));
                        onSelect(item);
                      }}
                    >
                      <span>{lane.label}</span>
                      <b>{lane.status}</b>
                    </div>
                  </div>
                </div>
            ))}
            {todayIndex >= 0 && todayIndex < columnCount && <div className="today-line" style={{ left: 195 + todayIndex * 49 + 22 }} />}
          </div>
        </div>
      )}
    </section>
  );
}

function UpcomingSettlements({ book, onSelect }: { book: Book; onSelect: (item: WorkflowContext) => void }) {
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
            <button className="action-card settlement-action" key={inv.id} onClick={() => onSelect(invoiceWorkflowContext(inv, book, 'Settlement readiness', `${d.toFixed(0)} days to maturity`))}>
              <div className="action-card-copy">
                <span className="eyebrow">Settlement review</span>
                <b>{inv.debtorName || short(inv.debtor)}</b>
                <span className="muted">#{inv.id} {inv.ref} · due {jst(inv.maturity)}</span>
              </div>
              <div className="action-card-meta">
                <span className="amt">{yen(inv.face - inv.funded)}</span>
                <span className={`pill-days${d <= 3 ? ' soon' : ''}`}>{d < 1 ? '<1d' : `${d.toFixed(0)}d`}</span>
                <span className="ai-review-link">Review with AI <span aria-hidden="true">→</span></span>
              </div>
            </button>
          );
        })
      )}
    </section>
  );
}

function DashboardActions({ book, s, onSelect }: { book: Book; s: Session; onSelect: (item: WorkflowContext) => void }) {
  const role = workspaceRole(book, s);
  const me = s.account.toLowerCase();
  const rows = role === 'Capital'
    ? book.invoices
      .filter((invoice) => invoice.status === 2 && invoice.poolCreated && invoice.tradable)
      .sort((a, b) => a.debtorGrade - b.debtorGrade || a.maturity - b.maturity)
      .slice(0, 6)
      .map((invoice) => ({ invoice, label: 'Review investment', detail: `${price(invoice.fair)} · G${invoice.debtorGrade} · ${Math.ceil(daysLeft(invoice, book.chainTime))}d` }))
    : role === 'Seller'
      ? book.invoices
        .filter((invoice) => invoice.supplier.toLowerCase() === me && (invoice.status === 1 || invoice.status === 2))
        .slice(0, 6)
        .map((invoice) => ({
          invoice,
          label: invoice.status === 1 ? 'Follow up with buyer' : invoice.poolCreated ? 'Review funding' : 'Open investor bidding',
          detail: invoice.status === 1 ? 'Awaiting acceptance' : `${yen(invoice.face - invoice.funded)} available`,
        }))
      : book.invoices
        .filter((invoice) => invoice.status === 1 || invoice.frozen || (invoice.status === 2 && book.chainTime > invoice.maturity))
        .slice(0, 6)
        .map((invoice) => ({
          invoice,
          label: invoice.frozen ? 'Resolve review hold' : invoice.status === 1 ? 'Review pending invoice' : 'Review overdue exposure',
          detail: invoice.frozen ? 'Trading paused' : invoice.status === 1 ? 'Buyer confirmation pending' : 'Past maturity',
        }));
  return (
    <section className="panel">
      <div className="panel-title"><h3>{role === 'Capital' ? 'What to bid on' : 'Needs your action'}</h3><span className="muted small-text">{role} queue</span></div>
      {rows.length === 0 ? (
        <p className="empty-state">No actionable items right now.</p>
      ) : (
        rows.map(({ invoice, label, detail }) => (
          <button className={`action-card priority-action ${role.toLowerCase()}`} key={invoice.id} onClick={() => onSelect(invoiceWorkflowContext(invoice, book, label, detail))}>
            <div className="action-card-copy">
              <span className="eyebrow">{role} priority</span>
              <b>{label}</b>
              <span className="muted">#{invoice.id} {invoice.ref} · {invoice.debtorName || short(invoice.debtor)}</span>
            </div>
            <div className="action-card-meta">
              <span className="action-detail">{detail}</span>
              <span className="ai-review-link">Ask AI what’s next <span aria-hidden="true">→</span></span>
            </div>
          </button>
        ))
      )}
    </section>
  );
}

type WorkspaceRole = 'Seller' | 'Operations' | 'Capital';
type WorkflowReview = { nextAction: string; urgency: string; risk: string; reason: string; owner: string; actionId?: string };
type AssistantMessage = { role: 'user' | 'assistant'; text: string; review?: WorkflowReview };
type AgentName = 'GPT' | 'Claude' | 'Gemini';
type AgentStatus = Record<AgentName, boolean>;
const MAX_ATTACHMENT_CHARS = 30_000;
const PLAYBOOK_STORAGE_KEY = 'workspace.playbook.v1';

type Sessions = Partial<Record<AgentName, string>>; // Claude Code session ids, so follow-ups keep the conversation

function loadPlaybook(): { provider?: AgentName; messages: AssistantMessage[]; sessions: Sessions } {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYBOOK_STORAGE_KEY) || '{}');
    const provider = ['GPT', 'Claude', 'Gemini'].includes(saved.provider) ? saved.provider : undefined;
    const messages = Array.isArray(saved.messages) ? saved.messages.slice(-100) : [];
    const sessions = saved.sessions && typeof saved.sessions === 'object' ? saved.sessions : {};
    return { provider, messages, sessions };
  } catch {
    return { messages: [], sessions: {} };
  }
}

/// Minimal, safe markdown for assistant replies: paragraphs, "-"/"1." lists, **bold** and `code`. Builds React elements
/// (never injects HTML), so model output can't smuggle markup into the page.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, k) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={k}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={k}>{part.slice(1, -1)}</code>
        : part,
  );
}

function RichText({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, k) => <li key={k}>{inline(item)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else {
      flush();
      if (line) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#{1,6}\s+/, ''))}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

/// Reads the ops desk's server-sent events (Claude Code): session, text, tool, done, error.
async function readAgentStream(response: Response, on: { text: (delta: string) => void; tool: (label: string) => void; session: (id: string) => void }) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const raw = frame.match(/^data: (.*)$/m)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === 'session') on.session(data.sessionId);
      else if (event === 'text') on.text(data.delta);
      else if (event === 'tool') on.tool(data.label);
      else if (event === 'done') {
        if (data.sessionId) on.session(data.sessionId);
        return String(data.reply ?? '');
      } else if (event === 'error') {
        if (data.sessionId) on.session(data.sessionId);
        throw new Error(data.error || 'Claude could not respond.');
      }
    }
  }
  throw new Error('The connection to Claude closed before it finished.');
}

async function readAssistantAttachment(file: File) {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ');
      pages.push(`[Page ${pageNumber}]\n${text}`);
      if (pages.join('\n\n').length >= MAX_ATTACHMENT_CHARS) break;
    }
    const extracted = pages.join('\n\n').slice(0, MAX_ATTACHMENT_CHARS).trim();
    if (!extracted) throw new Error('This PDF does not contain readable text. Scanned PDFs need OCR before attachment.');
    return extracted;
  }
  return (await file.text()).slice(0, MAX_ATTACHMENT_CHARS);
}

type PreparedAction = {
  id: string;
  role: WorkspaceRole;
  title: string;
  detail: string;
  button: string;
  address: Address;
  abi: readonly unknown[];
  fn: string;
  args: unknown[];
};

function workspaceRole(book: Book, s: Session): WorkspaceRole {
  if (book.me.isOperator) return 'Operations';
  const mine = book.invoices.some((invoice) => invoice.supplier.toLowerCase() === s.account.toLowerCase());
  return book.me.name || mine ? 'Seller' : 'Capital';
}

function preparedAction(dep: Deployment, s: Session, book: Book): PreparedAction | undefined {
  const role = workspaceRole(book, s);
  if (role === 'Operations') {
    const overdue = book.invoices.find((invoice) => invoice.status === 2 && book.chainTime > invoice.maturity + 3 * 86400);
    if (overdue) return {
      id: `operations:default:${overdue.id}`, role, title: `Mark invoice #${overdue.id} as defaulted`,
      detail: `${overdue.ref} is beyond maturity and the three-day grace period.`, button: 'Confirm default in wallet',
      address: dep.registry, abi: ABI.registry, fn: 'markDefault', args: [BigInt(overdue.id)],
    };
    const review = book.invoices.find((invoice) => (invoice.status === 1 || invoice.status === 2) && !invoice.frozen);
    if (review) return {
      id: `operations:freeze:${review.id}`, role, title: `Place invoice #${review.id} under review`,
      detail: `${review.ref} will stop trading until Operations unfreezes it.`, button: 'Confirm review hold in wallet',
      address: dep.registry, abi: ABI.registry, fn: 'setFrozen', args: [BigInt(review.id), true],
    };
    return undefined;
  }
  if (role === 'Seller') {
    const mine = book.invoices.filter((invoice) => invoice.supplier.toLowerCase() === s.account.toLowerCase());
    const ready = mine.find((invoice) => invoice.status === 2 && !invoice.poolCreated);
    if (ready) return {
      id: `seller:pool:${ready.id}`, role, title: `Open funding for invoice #${ready.id}`,
      detail: `${ready.ref} is accepted and ready for investor bids.`, button: 'Confirm pool creation in wallet',
      address: dep.market, abi: ABI.market, fn: 'createPool', args: [BigInt(ready.id)],
    };
    const inventory = mine.find((invoice) => invoice.status === 2 && invoice.poolCreated && invoice.myTokens > 0n);
    if (inventory) return {
      id: `seller:approve:${inventory.id}`, role, title: `Approve invoice #${inventory.id} for sale`,
      detail: `Authorize the marketplace to transfer this invoice inventory when you submit a sale.`, button: 'Confirm token approval in wallet',
      address: inventory.token, abi: ABI.token, fn: 'approve', args: [dep.market, MAX],
    };
    return undefined;
  }
  const amount = 50_000n * 10n ** 18n;
  if (book.me.jpycAllowanceMarket < amount) return {
    id: 'capital:approve-market', role, title: 'Approve JPYC for marketplace investing',
    detail: 'Authorize the marketplace before placing bids or purchasing invoice positions.', button: 'Confirm JPYC approval in wallet',
    address: dep.jpyc, abi: ABI.jpyc, fn: 'approve', args: [dep.market, MAX],
  };
  const target = book.invoices.find((invoice) => invoice.poolCreated && invoice.tradable && invoice.status === 2);
  if (!target || book.me.jpyc < amount) return undefined;
  return {
    id: `capital:buy:${target.id}`, role, title: `Invest ¥50,000 in invoice #${target.id}`,
    detail: `${target.ref} is tradable; execution includes 2% price protection and a ten-minute deadline.`, button: 'Confirm investment in wallet',
    address: dep.market, abi: ABI.market, fn: 'buy',
    args: [BigInt(target.id), amount, (amount * 10n ** 18n * 100n) / (target.fair * 102n), deadline(book)],
  };
}

const reviewSchema = (action?: PreparedAction) => [
  'Return only valid JSON with this exact shape:',
  '{"nextAction":"one specific action starting with a verb","urgency":"Now|Today|This week","risk":"the single most important risk or blocker","reason":"one short evidence-based reason","owner":"the team or role that should act","actionId":"approved action id or none"}',
  action ? `The only executable action you may propose is ${action.id}: ${action.title}. Use that exact actionId only when it supports your recommendation; otherwise use "none".` : 'No executable action is available. Use "none" for actionId.',
  'Do not claim that an action has been executed. Keep every value concise and use only the supplied data.',
].join('\n');

function portfolioSnapshot(book: Book) {
  return {
    chainTime: jst(book.chainTime),
    pricingBand: pct(Number(book.bandBps)),
    baseRate: pct(book.baseRateBps),
    account: {
      name: book.me.name,
      rated: book.me.rated,
      grade: book.me.grade,
      collateral: yen(book.me.collateral),
      collateralRequired: yen(book.me.collateralRequired),
      collateralLocked: yen(book.me.locked),
      collateralEarning: yen(book.me.stake),
      collateralInterest: yen(book.me.interest),
      collateralApr: pct(book.aprBps),
      rewardReserve: yen(book.rewardReserve),
      coverage: pct(book.me.coverageBps),
    },
    invoices: book.invoices.map((invoice) => ({
      id: invoice.id,
      reference: invoice.ref,
      supplier: invoice.supplierName || short(invoice.supplier),
      buyer: invoice.debtorName || short(invoice.debtor),
      buyerGrade: invoice.debtorGrade,
      faceValue: yen(invoice.face),
      funded: yen(invoice.funded),
      maturity: jst(invoice.maturity),
      daysToMaturity: Math.ceil((invoice.maturity - book.chainTime) / 86400),
      status: STATUS[invoice.status] || 'Unknown',
      frozen: invoice.frozen,
      tradable: invoice.tradable,
      poolCreated: invoice.poolCreated,
      fairPrice: price(invoice.fair),
    })),
  };
}

function AssistantPanel({ dep, s, book, send, selected, onClear }: Props & { selected?: WorkflowContext; onClear: () => void }) {
  const initialPlaybook = useRef(loadPlaybook());
  const [provider, setProvider] = useState<AgentName>(initialPlaybook.current.provider ?? 'Claude');
  const [sessions, setSessions] = useState<Sessions>(initialPlaybook.current.sessions);
  const [activity, setActivity] = useState<string>();
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>(initialPlaybook.current.messages);
  const [status, setStatus] = useState<AgentStatus>({ GPT: false, Claude: false, Gemini: false });
  const [statusReady, setStatusReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const [attachment, setAttachment] = useState<{ name: string; text: string }>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const panelRef = useRef<HTMLElement>(null);
  const snapshot = portfolioSnapshot(book);
  const role = workspaceRole(book, s);
  const action = preparedAction(dep, s, book);
  const shortcuts = [
    {
      label: `Prepare ${role} action`,
      prompt: `Act as the ${role} workspace assistant. Review the live portfolio and prepare the safest useful next action for human approval.\n\nPortfolio data:\n${JSON.stringify(snapshot, null, 2)}\n\n${reviewSchema(action)}`,
    },
    {
      label: 'Portfolio review',
      prompt: `Review this invoice portfolio. Prioritize the one issue that requires attention first.\n\nPortfolio data:\n${JSON.stringify(snapshot, null, 2)}\n\n${reviewSchema(action)}`,
    },
    {
      label: 'Funding recommendation',
      prompt: `Review the open invoices and identify the single best action to improve funding. Consider maturity, funded amount, buyer grade, pricing band, tradability, and pool availability.\n\nPortfolio data:\n${JSON.stringify(snapshot, null, 2)}\n\n${reviewSchema(action)}`,
    },
    {
      label: 'Settlement monitor',
      prompt: `Review settlement readiness across the invoices. Prioritize overdue or near-maturity exposure and recommend one action.\n\nPortfolio data:\n${JSON.stringify(snapshot, null, 2)}\n\n${reviewSchema(action)}`,
    },
    {
      label: 'Permission check',
      prompt: `Review the account eligibility, collateral coverage, frozen invoices, and tradability flags. Recommend one compliance or permission action.\n\nPortfolio data:\n${JSON.stringify(snapshot, null, 2)}\n\n${reviewSchema(action)}`,
    },
  ];

  useEffect(() => {
    fetch('/api/agents/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((next: AgentStatus) => {
        setStatus(next);
        // Don't sit on an assistant that isn't installed: fall back to the first connected one.
        setProvider((current) => (next[current] ? current : (['Claude', 'GPT', 'Gemini'] as AgentName[]).find((name) => next[name]) ?? current));
      })
      .catch(() => {})
      .finally(() => setStatusReady(true));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PLAYBOOK_STORAGE_KEY, JSON.stringify({ provider, messages: messages.slice(-100), sessions }));
    } catch {
      // The conversation remains available for this session when storage is unavailable.
    }
  }, [provider, messages, sessions]);

  const submit = async (text: string, workflow?: WorkflowContext, structuredLabel?: string) => {
    const clean = text.trim();
    if (!clean || loading) return;
    if (!status[provider]) {
      setMessages((current) => [...current, { role: 'assistant', text: `${provider} is not connected on this machine yet.` }]);
      return;
    }
    setMessages((current) => [...current, {
      role: 'user',
      text: workflow ? `Review invoice #${workflow.invoiceId} and recommend the next best action.` : structuredLabel || clean,
    }]);
    setDraft('');
    setLoading(true);
    setActivity(undefined);
    const structured = Boolean(workflow || structuredLabel);
    try {
      const response = await fetch('/api/agents/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          sessionId: sessions[provider],
          account: s.kind !== 'readonly' ? s.account : undefined,
          prompt: workflow
            ? `${clean}\n\nWorkflow context:\n${JSON.stringify(workflow, null, 2)}`
            : attachment ? `${clean}\n\nAttached file: ${attachment.name}\n${attachment.text}` : clean,
        }),
      });
      let reply: string;
      if ((response.headers.get('Content-Type') || '').includes('text/event-stream')) {
        // Claude Code streams: show text as it arrives (unless we're waiting for a JSON review card).
        let streamed = false;
        reply = await readAgentStream(response, {
          session: (id) => setSessions((current) => ({ ...current, [provider]: id })),
          tool: (label) => setActivity(label),
          text: (delta) => {
            setActivity(undefined);
            if (structured) return;
            setMessages((current) => (streamed
              ? [...current.slice(0, -1), { role: 'assistant', text: current[current.length - 1].text + delta }]
              : [...current, { role: 'assistant', text: delta }]));
            streamed = true;
          },
        });
        if (streamed) setMessages((current) => current.slice(0, -1)); // replaced by the final message below
      } else {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'The assistant could not respond.');
        reply = String(body.reply);
      }
      const result = { reply };
      let review: WorkflowReview | undefined;
      if (structured) {
        try {
          const json = String(result.reply).match(/\{[\s\S]*\}/)?.[0];
          const parsed = json ? JSON.parse(json) : undefined;
          if (parsed?.nextAction && parsed?.risk && parsed?.reason) {
            review = {
              nextAction: String(parsed.nextAction),
              urgency: String(parsed.urgency || 'Today'),
              risk: String(parsed.risk),
              reason: String(parsed.reason),
              owner: String(parsed.owner || 'Finance operations'),
              actionId: parsed.actionId && parsed.actionId !== 'none' ? String(parsed.actionId) : undefined,
            };
          }
        } catch {
          review = undefined;
        }
      }
      setMessages((current) => [...current, { role: 'assistant', text: review ? '' : result.reply, review }]);
      setAttachment(undefined);
      if (workflow) onClear();
    } catch (error: any) {
      setMessages((current) => [...current, { role: 'assistant', text: String(error?.message ?? error) }]);
    } finally {
      setLoading(false);
      setActivity(undefined);
    }
  };

  return (
    <section
      id="ai-operations-desk"
      ref={panelRef}
      className={`assistant-panel${draggingOver ? ' drag-target' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-invoice-workflow')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDraggingOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDraggingOver(false);
        const raw = event.dataTransfer.getData('application/x-invoice-workflow');
        if (!raw) return;
        const item = JSON.parse(raw) as WorkflowContext;
        submit(workflowPrompt(item), item);
      }}
    >
      <div className="assistant-head">
        <div>
          <span className="eyebrow">Workflow assistant</span>
          <h3>AI operations desk</h3>
        </div>
        <div className="assistant-head-actions">
          {messages.length > 0 && (
            <button className="ghost small" onClick={() => { setMessages([]); setSessions({}); }}>Clear history</button>
          )}
          <div className="provider-switch" aria-label="AI provider">
            {(['GPT', 'Claude', 'Gemini'] as AgentName[]).map((name) => (
              <button key={name} className={provider === name ? 'active' : ''} onClick={() => setProvider(name)}>
                <i className={status[name] ? 'connected' : ''} />{name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        <div className="workflow-review-card">
          <div>
            <span className="eyebrow">Selected workflow</span>
            <b>Invoice #{selected.invoiceId} · {selected.stage}</b>
            <span>{selected.status} · {selected.faceValue} · due {selected.dueDate.split(' ')[0]}</span>
          </div>
          <button className="ghost small" onClick={() => submit(workflowPrompt(selected), selected)} disabled={loading || !statusReady || !status[provider]}>Review next action</button>
          <button className="workflow-clear" onClick={onClear} aria-label="Clear selected workflow">×</button>
        </div>
      )}

      {draggingOver && <div className="workflow-drop-overlay">Drop to review the next best action</div>}

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
              {shortcuts.map((shortcut) => (
                <button key={shortcut.label} onClick={() => submit(shortcut.prompt, undefined, shortcut.label)} disabled={loading || !statusReady || !status[provider]}>
                  {shortcut.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="assistant-messages">
            {messages.map((message, index) => (
              message.review ? (
                <div className="next-action-card" key={`${message.role}-${index}`}>
                  <div className="next-action-topline"><span>Next best action</span><b>{message.review.urgency}</b></div>
                  <h3>{message.review.nextAction}</h3>
                  <div className="next-action-details">
                    <div><span>Primary risk</span><p>{message.review.risk}</p></div>
                    <div><span>Why this action</span><p>{message.review.reason}</p></div>
                  </div>
                  <div className="next-action-owner"><span>Owner</span><b>{message.review.owner}</b></div>
                  {message.review.actionId && action?.id === message.review.actionId && (
                    <div className="approval-card">
                      <div><span>Prepared transaction · {action.role}</span><b>{action.title}</b><p>{action.detail}</p></div>
                      <button onClick={() => send(action.title, action.address, action.abi, action.fn, action.args)}>{action.button}</button>
                    </div>
                  )}
                  {message.review.actionId && action?.id !== message.review.actionId && <p className="stale-action">This prepared action is no longer valid against current chain data. Ask the assistant to prepare a fresh action.</p>}
                </div>
              ) : (
                <div className={`assistant-message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.role === 'assistant' ? <RichText text={message.text} /> : message.text}
                </div>
              )
            ))}
            {loading && <div className="assistant-message assistant loading-message">{activity ? `${activity}…` : `${provider} is working…`}</div>}
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
                accept=".pdf,.txt,.md,.json,.csv,application/pdf,text/plain,text/markdown,application/json,text/csv"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setAttachmentError(undefined);
                  try {
                    setAttachment({ name: file.name, text: await readAssistantAttachment(file) });
                  } catch (error: any) {
                    setAttachment(undefined);
                    setAttachmentError(String(error?.message ?? 'Could not read this file.'));
                  } finally {
                    event.target.value = '';
                  }
                }}
              />
            </label>
            <button type="button" className="ghost small" onClick={() => setDraft('Create a workflow that ')}>Create</button>
          </div>
          <button type="submit" className="send-button" disabled={!draft.trim() || loading || !statusReady || !status[provider]} aria-label="Send message">↑</button>
        </div>
        {attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}
        {attachment && <p className="attachment-ready">PDF or document ready · {attachment.text.length.toLocaleString()} characters extracted</p>}
      </form>
    </section>
  );
}

export function PlaybookPage(props: Props) {
  return (
    <div className="playbook-page">
      <div className="playbook-title">
        <div>
          <span className="eyebrow">Persistent workspace</span>
          <h2>Playbook</h2>
        </div>
        <p className="muted">Your assistant conversations and next actions stay here when you change views or reload.</p>
      </div>
      <AssistantPanel {...props} onClear={() => {}} />
    </div>
  );
}

export function BookPage({ dep, s, book, send, onViewAll }: Props) {
  const [mb, setMb] = useState<MbBook>();
  const [mbErr, setMbErr] = useState<string>();
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowContext>();
  useEffect(() => setSelectedWorkflow(undefined), [s.account]);
  useEffect(() => {
    if (multibaasEnabled) fetchBookFromMultiBaas().then(setMb).catch((e) => setMbErr(String(e?.message ?? e)));
  }, [book.chainTime]);

  const active = book.invoices.filter((i) => i.status === 2);
  const outstanding = active.reduce((a, i) => a + (i.face - i.funded), 0n);

  return (
    <div>
      <MaturityBoard
        book={book}
        selected={selectedWorkflow}
        onSelect={(item) => {
          setSelectedWorkflow(item);
          window.setTimeout(() => document.getElementById('ai-operations-desk')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
        }}
      />
      <div className="grid">
        <UpcomingSettlements book={book} onSelect={(item) => {
          setSelectedWorkflow(item);
          window.setTimeout(() => document.getElementById('ai-operations-desk')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
        }} />
        <DashboardActions book={book} s={s} onSelect={(item) => {
          setSelectedWorkflow(item);
          window.setTimeout(() => document.getElementById('ai-operations-desk')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
        }} />
        <div className="hero">
          <span className="tag">Outstanding</span>
          <span><span className="figure">{yen(outstanding)}</span></span>
          <span className="muted small-text">across {active.length} active invoice{active.length === 1 ? '' : 's'}</span>
          <div className="hero-foot">
            <span className="small-text">{STATUS.slice(1).map((st, k) => `${st} ${book.invoices.filter((i) => i.status === k + 1).length}`).join(' · ')}</span>
            {onViewAll && <button onClick={onViewAll}>View invoices</button>}
          </div>
        </div>
        <AssistantPanel dep={dep} s={s} book={book} send={send} selected={selectedWorkflow} onClear={() => setSelectedWorkflow(undefined)} />
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
