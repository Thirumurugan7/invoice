import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from 'viem';
import { ABI } from './chain';

const ALL_ERRORS = [...ABI.registry, ...ABI.risk, ...ABI.hook, ...ABI.market, ...ABI.token, ...ABI.jpyc, ...ABI.customRevert, ...ABI.hooks].filter(
  (x: any) => x.type === 'error',
) as any[];

const p18 = (v: unknown) => (Number(BigInt(v as bigint)) / 1e18).toFixed(5);
const EXPLAIN: Record<string, (a: readonly unknown[]) => string> = {
  PriceOffCurve: (a) => `Rejected by the maturity-curve hook: price ${p18(a[0])} is ${a[2]} bps from the fair value ${p18(a[1])} (band ±${a[3]} bps). No predatory discounts, no pumping above the curve.`,
  TradingClosed: (a) => `Invoice #${a[0]} is not tradable (not accepted, frozen by the operator, or within 1 day of maturity).`,
  InitOffCurve: (a) => `Pool must start on the curve: ${p18(a[0])} vs fair ${p18(a[1])}.`,
  InvoiceNotAccepted: (a) => `Invoice #${a[0]} has not been accepted by the debtor yet.`,
  NotInvoicePool: () => 'Not an invoice/JPYC pool.',
  NotVerified: (a) => `${short(a[0])} is not a KYB-verified company.`,
  NotRated: (a) => `${short(a[0])} has no credit grade yet — the operator must rate the debtor before invoices can be priced.`,
  Expired: () => 'Transaction deadline passed.',
  NotOwner: () => 'Not your bid position.',
  DuplicateInvoice: (a) => `This invoice document is already financed as invoice #${a[0]} (二重譲渡 blocked).`,
  InvalidTerms: () => 'Invalid terms (face > 0, tenor ≥ 1 day, debtor ≠ supplier).',
  NotDebtor: () => 'Only the invoice debtor can do this.',
  BadStatus: (a) => `Invoice is in the wrong state (${['None', 'Pending', 'Accepted', 'Rejected', 'Settled', 'Defaulted'][Number(a[0])]}).`,
  NotYetDefaultable: (a) => `Cannot mark default before maturity + 3-day grace (${new Date(Number(a[0]) * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST).`,
  Slippage: (a) => `Slippage: got ${p18(a[0])}, minimum ${p18(a[1])}.`,
  NoPosition: () => 'No bid position (or one already exists — withdraw first).',
  AccessControlUnauthorizedAccount: (a) => `${short(a[0])} lacks the operator role.`,
  ERC20InsufficientAllowance: () => 'Allowance too low — approve first.',
  ERC20InsufficientBalance: () => 'Insufficient balance.',
};

export type DecodedRevert = { name: string; message: string; chain: string[] };

export function explainError(err: unknown): DecodedRevert {
  const data = revertData(err);
  if (!data) return { name: 'Error', message: err instanceof BaseError ? err.shortMessage : String((err as any)?.message ?? err), chain: [] };
  return decodeNested(data, []);
}

function decodeNested(data: Hex, chain: string[]): DecodedRevert {
  try {
    const d = decodeErrorResult({ abi: ALL_ERRORS, data });
    const args = (d.args ?? []) as readonly unknown[];
    if (d.errorName === 'WrappedError') return decodeNested(args[2] as Hex, [...chain, `WrappedError(from ${short(args[0])})`]);
    const f = EXPLAIN[d.errorName];
    return { name: d.errorName, message: f ? f(args) : `${d.errorName}(${args.map(String).join(', ')})`, chain: [...chain, d.errorName] };
  } catch {
    return { name: 'UnknownRevert', message: `Reverted (${data.slice(0, 10)})`, chain };
  }
}

function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (r?.raw) return r.raw;
  return (err.walk((e: any) => typeof e?.data === 'string' && e.data.startsWith('0x')) as any)?.data;
}

export const short = (a: unknown) => {
  const s = String(a);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
export const yen = (wei: bigint) => `¥${(Number(wei / 10n ** 16n) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}`;
export const price = (v: bigint) => (Number(v) / 1e18).toFixed(5);
export const jst = (sec: number) => new Date(sec * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }) + ' JST';
