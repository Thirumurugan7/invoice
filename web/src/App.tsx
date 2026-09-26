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
import { BookPage, DebtorPage, InvestorPage, OperatorPage, SupplierPage } from './pages';
import { useBook, useTx, type Book, type TxStatus } from './state';

const TABS = ['Supplier', 'Debtor', 'Investor', 'Book', 'Operator'] as const;
type Tab = (typeof TABS)[number];
const LAST_WALLET = 'tegata.lastWallet';
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
  const [tab, setTab] = useState<Tab>('Investor');
  const [tick, setTick] = useState(0);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [picker, setPicker] = useState(false);
  const [wrongChain, setWrongChain] = useState<number>();
  const [connectErr, setConnectErr] = useState<string>();
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

  const { book, err } = useBook(dep, s, tick);
  const { status, send } = useTx(s, dep?.chainId, refresh, askConnect);

  // After connecting, open the tab that matches what this wallet is on-chain.
  const roleTabPending = useRef(false);
  useEffect(() => {
    if (!roleTabPending.current || !book || !s || s.kind !== 'wallet') return;
    roleTabPending.current = false;
    const me = s.account.toLowerCase();
    if (book.me.isOperator) setTab('Operator');
    else if (book.invoices.some((i) => i.debtor.toLowerCase() === me)) setTab('Debtor');
    else if (book.me.name || book.invoices.some((i) => i.supplier.toLowerCase() === me)) setTab('Supplier');
    else setTab('Investor');
  }, [book, s]);

  if (loadErr) return <div className="shell"><p className="error">{loadErr}</p></div>;
  if (!dep || !s) return <div className="shell">Loading…</div>;
  const connected = s.kind !== 'readonly';

  return (
    <div className="shell">
      <header>
        <div>
          <h1>Tegata <span className="muted">手形 → JPYC on Uniswap v4{dep.chainId === 11155111 ? ' · Sepolia' : ''}</span></h1>
          <p className="muted">Paper promissory notes end. Tokenized, debtor-acknowledged invoices trade on a credit-priced discount curve that converges to face value at maturity.</p>
        </div>
        <div className="acct">
          {local ? (
            <select
              defaultValue={1}
              onChange={(e) => {
                const i = Number(e.target.value);
                setS(devSession(DEV_ACCOUNTS[i].key, dep.chainId));
                setTab((DEV_ACCOUNTS[i].role === 'Operator' ? 'Operator' : DEV_ACCOUNTS[i].role) as Tab);
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
      </header>
      {connectErr && <p className="error">{connectErr}</p>}
      {wrongChain !== undefined && s.provider && (
        <div className="banner error">
          Your wallet is on chain {wrongChain}. Tegata runs on Sepolia.{' '}
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
        <div className="banner pending">Read-only view of the live Sepolia market. Connect a wallet (MetaMask, Rabby, …) to register, accept, pay, trade or redeem.</div>
      )}
      <nav>{TABS.map((t) => (<button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>))}</nav>
      <Banner status={status} chainId={dep.chainId} />
      {err && <p className="error">{err}</p>}
      {book && (
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

type Send = (label: string, address: Address, abi: readonly unknown[], fn: string, args: unknown[]) => Promise<void>;

/// Who this wallet is on-chain, and what it needs before it can act: gas and JPYC (official faucet). No KYB/KYC:
/// any wallet can register, accept, pay, trade and redeem.
function WalletPanel({ dep, s, book, send }: { dep: Deployment; s: Session; book: Book; send: Send }) {
  const role = book.me.isOperator
    ? 'Operator (OPERATOR_ROLE)'
    : book.me.name
      ? `${book.me.name} (self-declared)`
      : 'No company name set — add one on the Supplier or Debtor tab';
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
      <div className="muted small-text">
        <button className="ghost small" onClick={() => navigator.clipboard?.writeText(s.account)}>Copy address</button>
      </div>
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
