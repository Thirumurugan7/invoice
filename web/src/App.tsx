import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, type Address } from 'viem';
import {
  DEV_ACCOUNTS,
  devSession,
  discoverWallets,
  ensureChain,
  explorerAddress,
  explorerTx,
  FAUCET_ABI,
  JPYC_FAUCET,
  loadDeployment,
  readonlySession,
  sessionFor,
  walletChainId,
  walletSession,
  warpDays,
  type Deployment,
  type Session,
  type WalletInfo,
} from './chain';
import { jst, short, yen } from './errors';
import { ConsumerDashboard } from './consumer';
import { ActivityPage, BookPage, DebtorPage, InvestorPage, OperatorPage, PermissionsPage, PlaybookPage, SupplierPage } from './pages';
import { useBook, useTx, type Book, type TxStatus } from './state';

const TABS = ['Book', 'Invoices', 'Marketplace', 'Playbook', 'Activity', 'Permissions', 'Operator'] as const;
type Tab = (typeof TABS)[number];
const CONSUMER_TABS = ['Book', 'Invoices', 'Playbook'] as const;
const TAB_LABEL: Record<Tab, string> = {
  Book: 'Dashboard',
  Invoices: 'Invoices',
  Marketplace: 'Marketplace',
  Permissions: 'Wallet & Permissions',
  Activity: 'Transaction Activity',
  Playbook: 'Playbook',
  Operator: 'Admin Console',
};
const TAB_ICON: Record<Tab, JSX.Element> = {
  Book: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  ),
  Invoices: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3.5h7l3 3V20.5H7z" /><path d="M14 3.5V7h3" /><path d="M9.5 11h5" /><path d="M9.5 15h4" />
    </svg>
  ),
  Marketplace: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16" /><path d="M6 9l1-4h10l1 4" /><path d="M7 9v10" /><path d="M17 9v10" /><path d="M4 19h16" />
    </svg>
  ),
  Permissions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  ),
  Activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /><path d="M17 16l2 2 3-4" />
    </svg>
  ),
  Playbook: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4.5h10a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z" /><path d="M8 19.5a3 3 0 0 1 0-6h10" /><path d="M9 8h5" />
    </svg>
  ),
  Operator: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  ),
};
const LAST_WALLET = 'workspace.lastWallet';
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export default function App() {
  const [dep, setDep] = useState<Deployment>();
  const [loadErr, setLoadErr] = useState<string>();
  const [s, setS] = useState<Session>();
  const [devIndex, setDevIndex] = useState(1);
  const [tab, setTab] = useState<Tab>('Book');
  const [tick, setTick] = useState(0);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [picker, setPicker] = useState(false);
  const [wrongChain, setWrongChain] = useState<number>();
  const [connectErr, setConnectErr] = useState<string>();
  const [search, setSearch] = useState('');
  const [workspace, setWorkspace] = useState('Treasury Operations');
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const local = dep?.chainId === 31337;

  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDep(d);
        setS(d.chainId === 31337 ? devSession(DEV_ACCOUNTS[1].key, d.chainId) : readonlySession(d.chainId));
      })
      .catch((e) => setLoadErr(String(e.message ?? e)));
  }, []);

  useEffect(() => (dep && !local ? discoverWallets(setWallets) : undefined), [dep, local]);

  // Page reload: silently restore the wallet the user connected last time (no prompt).
  const restored = useRef(false);
  useEffect(() => {
    if (!dep || local || restored.current || wallets.length === 0) return;
    const last = wallets.find((w) => w.rdns === store.get(LAST_WALLET));
    if (!last) return;
    restored.current = true;
    walletSession(last.provider, dep.chainId, false).then((sess) => sess && adopt(sess)).catch(() => {});
  }, [dep, local, wallets]);

  // Follow the wallet: account switches, disconnects and network changes.
  useEffect(() => {
    const p = s?.provider;
    if (!p?.on || !dep) return;
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) return disconnect();
      setS(sessionFor(p, getAddress(accs[0]), dep.chainId));
      refresh();
    };
    const onChain = (hex: string) => setWrongChain(Number(hex) === dep.chainId ? undefined : Number(hex));
    p.on('accountsChanged', onAccounts);
    p.on('chainChanged', onChain);
    return () => {
      p.removeListener?.('accountsChanged', onAccounts);
      p.removeListener?.('chainChanged', onChain);
    };
  }, [s?.provider, dep]);

  const adopt = async (sess: Session) => {
    setS(sess);
    if (sess.provider && dep) {
      const id = await walletChainId(sess.provider);
      setWrongChain(id === dep.chainId ? undefined : id);
    }
    refresh();
  };

  const connect = async (w: WalletInfo) => {
    if (!dep) return;
    setPicker(false);
    setConnectErr(undefined);
    try {
      const sess = await walletSession(w.provider, dep.chainId, true);
      if (!sess) return;
      store.set(LAST_WALLET, w.rdns);
      await adopt(sess);
      roleTabPending.current = true;
    } catch (e: any) {
      setConnectErr(e?.code === 4001 ? 'Connection rejected in wallet.' : String(e?.shortMessage ?? e?.message ?? e));
    }
  };

  const disconnect = () => {
    store.set(LAST_WALLET, null);
    s?.provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    if (dep) setS(readonlySession(dep.chainId));
    setWrongChain(undefined);
  };

  const askConnect = useCallback(() => (wallets.length === 1 ? connect(wallets[0]) : setPicker(true)), [wallets, dep]);
  const isConsumer = workspace === 'Consumer Finance';

  const { book, err } = useBook(dep, s, tick);
  const { status, send } = useTx(s, dep?.chainId, refresh, askConnect);

  // After connecting, open the tab that matches what this wallet is on-chain.
  const roleTabPending = useRef(false);
  useEffect(() => {
    if (!roleTabPending.current || !book || !s || s.kind !== 'wallet') return;
    roleTabPending.current = false;
    const me = s.account.toLowerCase();
    if (book.me.isOperator) setTab('Operator');
    else if (book.invoices.some((i) => i.debtor.toLowerCase() === me)) setTab('Invoices');
    else if (book.me.name || book.invoices.some((i) => i.supplier.toLowerCase() === me)) setTab('Invoices');
    else setTab('Marketplace');
  }, [book, s]);

  if (loadErr) return <div className="shell"><p className="error">{loadErr}</p></div>;
  if (!dep || !s) return <div className="shell">Loading…</div>;
  const connected = s.kind !== 'readonly';
  const runSearch = () => {
    const value = search.trim().toLowerCase();
    if (!value) return;
    if (/permission|wallet|sign/.test(value)) setTab('Permissions');
    else if (/activity|transaction|settlement/.test(value)) setTab('Activity');
    else if (/playbook|chat|assistant|action/.test(value)) setTab('Playbook');
    else if (/admin|operator|company|credit/.test(value)) setTab('Operator');
    else if (/sell|upload|early|invoice/.test(value)) setTab('Invoices');
    else if (/invest|bid|market|buyer/.test(value)) setTab('Marketplace');
    else setTab('Invoices');
  };
  const selectWorkspace = (value: string) => {
    setWorkspace(value);
    const index = value === 'Treasury Operations' ? 0 : value === 'Capital Account' ? 3 : value === 'Consumer Finance' ? 4 : 1;
    // Always land on the role's own page (the previous page may not exist in the new role's navigation).
    setTab(value === 'Consumer Finance' ? 'Book' : index === 0 ? 'Operator' : index === 3 ? 'Marketplace' : 'Invoices');
    if (!local) return; // on Sepolia the connected wallet stays; only the local demo switches accounts
    setS(devSession(DEV_ACCOUNTS[index].key, dep.chainId));
    setDevIndex(index);
  };
  // Consumer Finance only has Dashboard, Invoices and Playbook; never render a page outside the current role's rail.
  const view: Tab = isConsumer && !CONSUMER_TABS.includes(tab as (typeof CONSUMER_TABS)[number]) ? 'Book' : tab;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          <img src="/mark.png?v=1" alt="Liquidity Desk" />
        </div>
        {(isConsumer ? CONSUMER_TABS : TABS).map((t) => (
          <button key={t} className={t === view ? 'rail-btn active' : 'rail-btn'} title={isConsumer && t === 'Book' ? 'Dashboard' : TAB_LABEL[t]} onClick={() => setTab(t)}>
            {TAB_ICON[t]}
          </button>
        ))}
        <div className="rail-spacer" />
      </aside>
      <div className="main-col">
        <div className="topbar">
          <div className="brand">
            <b>Liquidity Desk</b>
            <span className="muted">{dep.chainId === 11155111 ? 'Sepolia' : dep.chainId === 31337 ? 'Local chain' : `Chain ${dep.chainId}`}</span>
          </div>
          {!isConsumer && (
            <label className="global-search">
              <span>Search</span>
              <input
                value={search}
                placeholder="Invoice, buyer, settlement"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
              />
            </label>
          )}
          <select className="company-switcher" aria-label="Company account" value={workspace} onChange={(event) => selectWorkspace(event.target.value)}>
            <option>Treasury Operations</option>
            <option>Seller Account</option>
            <option>Capital Account</option>
            <option>Consumer Finance</option>
          </select>
          <button className="upload-cta" onClick={() => setTab('Invoices')}>Upload Invoice</button>
          <div className="topbar-spacer" />
          <div className="acct">
            {local ? (
              <select
                value={devIndex}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  setS(devSession(DEV_ACCOUNTS[i].key, dep.chainId));
                  setDevIndex(i);
                  if (i === 4) {
                    setWorkspace('Consumer Finance');
                    setTab('Book');
                  } else {
                    if (isConsumer) setWorkspace('Treasury Operations');
                    setTab(DEV_ACCOUNTS[i].role === 'Operator' ? 'Operator' : DEV_ACCOUNTS[i].role === 'Investor' ? 'Marketplace' : 'Invoices');
                  }
                }}
              >
                {DEV_ACCOUNTS.map((a, i) => (<option key={a.label} value={i}>{a.label} (local)</option>))}
              </select>
            ) : connected ? (
              <div className="wallet-chip">
                <span className={`dot ${wrongChain ? 'bad' : 'good'}`} />
                <a className="mono" href={explorerAddress(dep.chainId, s.account)} target="_blank" rel="noreferrer">{short(s.account)}</a>
                <button className="ghost small" onClick={disconnect}>Disconnect</button>
              </div>
            ) : (
              <div className="wallet-connect">
                <button onClick={askConnect} disabled={wallets.length === 0}>Connect wallet</button>
                {wallets.length === 0 && (
                  <p className="muted small-text">
                    No wallet detected — <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">install MetaMask</a>
                  </p>
                )}
                {picker && (
                  <div className="picker">
                    {wallets.map((w) => (
                      <button key={w.uuid} className="ghost" onClick={() => connect(w)}>
                        {w.icon && <img src={w.icon} alt="" />} {w.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="page-intro">
          {isConsumer ? (
            <>
              <h1>Consumer Finance <span className="muted">{dep.chainId === 11155111 ? ' · Sepolia' : dep.chainId === 31337 ? ' · Local demo' : ''}</span></h1>
              <p className="muted">Verify once with World ID and see how much of a personal invoice you can access today — no company or KYB required.</p>
            </>
          ) : (
            <>
              <h1>Invoice liquidity workspace <span className="muted">{dep.chainId === 11155111 ? ' · Sepolia' : dep.chainId === 31337 ? ' · Local demo' : ''}</span></h1>
              <p className="muted">Get paid early, review investor bids, and monitor delegated settlement status from one operator-grade finance console.</p>
            </>
          )}
        </div>

        {connectErr && <p className="error">{connectErr}</p>}
        {wrongChain !== undefined && s.provider && (
          <div className="banner error">
            Your wallet is on chain {wrongChain}. This workspace runs on Sepolia.{' '}
            <button className="small" onClick={() => ensureChain(s.provider!, dep.chainId).then(() => setWrongChain(undefined)).catch(() => {})}>Switch to Sepolia</button>
          </div>
        )}
        {local && book && (
          <div className="warpbar">
            <span className="muted">Chain time {jst(book.chainTime)}</span>
            {[30, 59, 90, 93].map((d) => (<button key={d} className="ghost small" onClick={() => warpDays(d).then(refresh)}>+{d}d</button>))}
          </div>
        )}
        {s.kind === 'wallet' && book && <WalletPanel dep={dep} s={s} book={book} send={send} />}
        {s.kind === 'readonly' && (
          <div className="banner pending">
            {isConsumer
              ? 'Read-only view. Connect a wallet to verify with World ID, upload a personal invoice, and check your advance.'
              : 'Read-only view of the invoice marketplace. Connect a wallet to upload invoices, review bids, approve payments, invest, or redeem settled positions.'}
          </div>
        )}
        <Banner status={status} chainId={dep.chainId} />
        {err && <p className="error">{err}</p>}
        {book && (
          <main>
            {view === 'Invoices' && (
              book.me.isOperator
                ? <OperatorPage dep={dep} s={s} book={book} send={send} />
                : book.invoices.some((invoice) => invoice.debtor.toLowerCase() === s.account.toLowerCase())
                  ? <DebtorPage dep={dep} s={s} book={book} send={send} />
                  : <SupplierPage dep={dep} s={s} book={book} send={send} isConsumer={isConsumer} />
            )}
            {view === 'Marketplace' && <InvestorPage dep={dep} s={s} book={book} send={send} />}
            {view === 'Permissions' && <PermissionsPage dep={dep} s={s} book={book} send={send} />}
            {view === 'Activity' && <ActivityPage dep={dep} s={s} book={book} send={send} />}
            {view === 'Playbook' && <PlaybookPage dep={dep} s={s} book={book} send={send} />}
            {view === 'Book' && (workspace === 'Consumer Finance'
              ? <ConsumerDashboard session={s} />
              : <BookPage dep={dep} s={s} book={book} send={send} onViewAll={() => setTab('Marketplace')} />)}
            {view === 'Operator' && <OperatorPage dep={dep} s={s} book={book} send={send} />}
          </main>
        )}
      </div>
    </div>
  );
}

type Send = (label: string, address: Address, abi: readonly unknown[], fn: string, args: unknown[]) => Promise<void>;

/// Who this wallet is on-chain, and what it needs before it can act: gas and JPYC.
function WalletPanel({ dep, s, book, send }: { dep: Deployment; s: Session; book: Book; send: Send }) {
  const role = book.me.isOperator
    ? 'Operator access active'
    : book.me.name
      ? `${book.me.name} · open-access account`
      : 'Open-access account · add a company name from the invoice screen';
  const canClaim = book.me.jpyc <= 1_000_000n * 10n ** 18n;
  return (
    <section className="card wallet-panel">
      <div>
        <b>Your wallet</b> <span className="mono muted">{short(s.account)}</span>
        <div className="muted">{role}</div>
      </div>
      <div>
        <div>{Number(formatEther(book.me.eth)).toFixed(4)} SepoliaETH</div>
        {book.me.eth === 0n && (
          <div className="muted small-text">
            Needs gas — <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noreferrer">Sepolia faucet</a>
          </div>
        )}
      </div>
      <div>
        <div>{yen(book.me.jpyc)} JPYC</div>
        <button
          className="ghost small"
          disabled={!canClaim}
          title={canClaim ? 'JPYC Inc. official Sepolia faucet' : 'Faucet only pays wallets holding ≤ ¥1,000,000'}
          onClick={() => send('Claim ¥3,000,000 test JPYC (official JPYC faucet)', JPYC_FAUCET.address, FAUCET_ABI, 'sendToken', [s.account, JPYC_FAUCET.claim])}
        >
          Get test JPYC
        </button>
      </div>
      <button className="ghost small" onClick={() => navigator.clipboard?.writeText(s.account)}>Copy address</button>
      {dep && null}
    </section>
  );
}

function Banner({ status, chainId }: { status: TxStatus; chainId: number }) {
  if (status.kind === 'idle') return null;
  const link = (hash?: string) =>
    hash ? (
      <a className="mono" href={explorerTx(chainId, hash)} target="_blank" rel="noreferrer">
        {short(hash)}
      </a>
    ) : null;
  if (status.kind === 'pending')
    return (
      <div className="banner pending">
        {status.stage === 'wallet' ? `${status.label}: confirm in your wallet…` : `${status.label}: waiting for the block…`} {link(status.hash)}
      </div>
    );
  if (status.kind === 'ok') return <div className="banner ok">✓ {status.label} {link(status.hash)}</div>;
  return (
    <div className="banner error">
      <b>✗ {status.label}: {status.revert.name}</b>
      <div>{status.revert.message}</div>
      {status.revert.chain.length > 1 && <div className="muted mono">{status.revert.chain.join(' → ')}</div>}
    </div>
  );
}
