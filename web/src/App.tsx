import { useCallback, useEffect, useState } from 'react';
import { DEV_ACCOUNTS, devSession, hasDemoKeys, injectedSession, loadDeployment, warpDays, type Deployment, type Session } from './chain';
import { jst, short } from './errors';
import { BookPage, DebtorPage, InvestorPage, OperatorPage, SupplierPage } from './pages';
import { useBook, useTx, type TxStatus } from './state';

const TABS = ['Supplier', 'Debtor', 'Investor', 'Book', 'Operator'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [dep, setDep] = useState<Deployment>();
  const [loadErr, setLoadErr] = useState<string>();
  const [s, setS] = useState<Session>();
  const [tab, setTab] = useState<Tab>('Supplier');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDep(d);
        if (d.chainId === 31337 || hasDemoKeys) setS(devSession(DEV_ACCOUNTS[1].key, d.chainId));
      })
      .catch((e) => setLoadErr(String(e.message ?? e)));
  }, []);

  const { book, err } = useBook(dep, s, tick);
  const { status, send } = useTx(s, refresh);
  const local = dep?.chainId === 31337;
  const demo = local || hasDemoKeys;
  if (loadErr) return <div className="shell"><p className="error">{loadErr}</p></div>;
  if (!dep) return <div className="shell">Loading…</div>;

  return (
    <div className="shell">
      <header>
        <div>
          <h1>Tegata <span className="muted">手形 → JPYC on Uniswap v4{dep.chainId === 11155111 ? ' · Sepolia' : ''}</span></h1>
          <p className="muted">Paper promissory notes end. Tokenized, debtor-acknowledged invoices trade on a discount curve that converges to face value at maturity.</p>
        </div>
        <div className="acct">
          {demo ? (
            <select
              defaultValue={1}
              onChange={(e) => {
                const i = Number(e.target.value);
                setS(devSession(DEV_ACCOUNTS[i].key, dep.chainId));
                setTab((DEV_ACCOUNTS[i].role === 'Operator' ? 'Operator' : DEV_ACCOUNTS[i].role) as Tab);
              }}
            >
              {DEV_ACCOUNTS.map((a, i) => (<option key={a.label} value={i}>{a.label}</option>))}
            </select>
          ) : (
            <button onClick={() => injectedSession(dep.chainId).then(setS)}>{s ? short(s.account) : 'Connect wallet'}</button>
          )}
        </div>
      </header>
      {local && book && (
        <div className="warpbar">
          <span className="muted">Chain time {jst(book.chainTime)}</span>
          {[30, 59, 90, 93].map((d) => (<button key={d} className="ghost small" onClick={() => warpDays(d).then(refresh)}>+{d}d</button>))}
        </div>
      )}
      <nav>{TABS.map((t) => (<button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>))}</nav>
      <Banner status={status} />
      {err && <p className="error">{err}</p>}
      {s && book && (
        <main>
          {tab === 'Supplier' && <SupplierPage dep={dep} s={s} book={book} send={send} />}
          {tab === 'Debtor' && <DebtorPage dep={dep} s={s} book={book} send={send} />}
          {tab === 'Investor' && <InvestorPage dep={dep} s={s} book={book} send={send} />}
          {tab === 'Book' && <BookPage dep={dep} s={s} book={book} send={send} />}
          {tab === 'Operator' && <OperatorPage dep={dep} s={s} book={book} send={send} />}
        </main>
      )}
    </div>
  );
}

function Banner({ status }: { status: TxStatus }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'pending') return <div className="banner pending">{status.label}…</div>;
  if (status.kind === 'ok') return <div className="banner ok">✓ {status.label} <span className="mono">{short(status.hash)}</span></div>;
  return (
    <div className="banner error">
      <b>✗ {status.label} reverted: {status.revert.name}</b>
      <div>{status.revert.message}</div>
      {status.revert.chain.length > 1 && <div className="muted mono">{status.revert.chain.join(' → ')}</div>}
    </div>
  );
}
