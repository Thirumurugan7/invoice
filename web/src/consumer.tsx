import { useEffect, useMemo, useState } from 'react';
import { IDKitRequestWidget } from '@worldcoin/idkit';
import { selfieCheck, type IDKitErrorCodes, type IDKitResult, type RpContext } from '@worldcoin/idkit-core';
import type { Session } from './chain';
import { short } from './errors';

const ACTION = 'consumer-invoice-advance';
const APP_ID = import.meta.env.VITE_WORLD_APP_ID as `app_${string}` | undefined;

type Verification = { address: string; score: number; verifiedAt: number; nullifier: string };

function scorePercent(score: number) {
  return Math.max(0, Math.min(100, score <= 10 ? score * 10 : score));
}

function money(value: number) {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value || 0);
}

export function ConsumerDashboard({ session }: { session: Session }) {
  const [amount, setAmount] = useState('300000');
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<RpContext>();
  const [verification, setVerification] = useState<Verification>();
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const invoice = Math.max(0, Number(amount) || 0);
  const percent = verification ? scorePercent(verification.score) : 0;
  const available = Math.floor((invoice * percent) / 100);
  const held = invoice - available;

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    fetch(`/api/world/status?address=${session.account}`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load World ID status.');
        setConfigured(Boolean(result.configured));
        setVerification(result.verification || undefined);
      })
      .catch((reason) => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false));
  }, [session.account]);

  const tiers = useMemo(() => [
    { label: 'Available now', value: available, active: true },
    { label: 'Released after repayment evidence', value: held, active: false },
  ], [available, held]);

  const startVerification = async () => {
    setError(undefined);
    setLoading(true);
    try {
      const response = await fetch('/api/world/rp-context', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: ACTION }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not prepare Selfie Check.');
      setContext(result.rp_context);
      setOpen(true);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (result: IDKitResult) => {
    const response = await fetch('/api/world/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: session.account, result }),
    });
    const verified = await response.json();
    if (!response.ok) throw new Error(verified.error || 'World ID verification failed.');
    setVerification(verified.verification);
  };

  return (
    <div className="consumer-dashboard">
      <section className="consumer-hero">
        <div>
          <span className="eyebrow">Consumer invoice advance</span>
          <h2>Access liquidity based on verified human trust</h2>
          <p>Selfie Check adds the minimum assurance needed for a consumer advance: liveness and resistance to repeated enrollment, without asking for a passport or Orb verification.</p>
        </div>
        <div className={`world-status${verification ? ' verified' : ''}`}>
          <span>{verification ? 'World ID verified' : 'Verification required'}</span>
          <b>{verification ? `Sybil score ${verification.score}` : short(session.account)}</b>
          <small>{verification ? `${percent}% immediate-access tier` : 'Complete Selfie Check to calculate your limit'}</small>
        </div>
      </section>

      <div className="consumer-grid">
        <section className="panel advance-calculator">
          <div className="panel-title"><h3>Your invoice</h3><span className="muted small-text">B2C example</span></div>
          <label className="field"><span>Invoice amount</span><input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))} /></label>
          <div className="advance-total"><span>Available immediately</span><b>{money(available)}</b><small>{verification ? `${percent}% from verified score ${verification.score}` : 'Verify to unlock an advance'}</small></div>
          <div className="advance-split">
            {tiers.map((tier) => <div className={tier.active ? 'active' : ''} key={tier.label}><span>{tier.label}</span><b>{money(tier.value)}</b></div>)}
          </div>
        </section>

        <section className="panel identity-check">
          <div className="panel-title"><h3>Human trust check</h3><span className="world-mark">W</span></div>
          <p className="muted">Your score is read from a real Selfie Check response only after World verifies its integrity bundle on the server.</p>
          <div className="trust-steps">
            <div className={verification ? 'complete' : 'current'}><b>1</b><span><strong>Selfie and liveness</strong><small>Completed in World ID</small></span></div>
            <div className={verification ? 'complete' : ''}><b>2</b><span><strong>Server proof verification</strong><small>World v4 verification API</small></span></div>
            <div className={verification ? 'complete' : ''}><b>3</b><span><strong>Advance limit</strong><small>Calculated from the verified score</small></span></div>
          </div>
          {!verification && <button onClick={startVerification} disabled={loading || !configured || !APP_ID}>{loading ? 'Checking…' : 'Verify with World ID'}</button>}
          {verification && <div className="verified-result"><b>{percent}% available now</b><span>Verified {new Date(verification.verifiedAt * 1000).toLocaleString()}</span></div>}
          {!configured && !loading && <p className="form-warning">World ID credentials are not configured on this server.</p>}
          {error && <p className="form-warning" role="alert">{error}</p>}
        </section>
      </div>

      <section className="panel trust-policy">
        <div><span className="eyebrow">Proportionate credential</span><h3>Why Selfie Check</h3></div>
        <p>Consumer invoice access needs meaningful abuse resistance, but not government identity. The Sybil score is a versioned risk signal rather than a uniqueness verdict, so it adjusts the advance instead of acting as a pass/fail gate.</p>
      </section>

      {/* environment="production": real proofs from the regular World App. Must match the check in vite.config.ts's /api/world/verify. */}
      {context && APP_ID && <IDKitRequestWidget open={open} onOpenChange={setOpen} app_id={APP_ID} action={ACTION} rp_context={context} allow_legacy_proofs={false} environment="production" preset={selfieCheck({ signal: session.account })} handleVerify={handleVerify} onSuccess={() => setOpen(false)} onError={(code: IDKitErrorCodes) => setError(`Selfie Check did not complete (${code}). You can retry when ready.`)} />}
    </div>
  );
}
