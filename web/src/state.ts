import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { ABI, type Deployment, type Session } from './chain';
import { explainError, type DecodedRevert } from './errors';

export const STATUS = ['None', 'Pending', 'Accepted', 'Rejected', 'Settled', 'Defaulted'] as const;

export type InvoiceRow = {
  id: number;
  supplier: Address;
  debtor: Address;
  supplierName: string;
  debtorName: string;
  token: Address;
  face: bigint;
  maturity: number;
  rateBps: number; // debtor's live rate (CreditRiskModel)
  rateAtIssueBps: number;
  debtorGrade: number;
  frozen: boolean;
  status: number;
  funded: bigint;
  tradable: boolean;
  fair: bigint;
  poolCreated: boolean;
  poolPrice?: bigint;
  deviationBps?: bigint;
  myTokens: bigint;
  myPositions: { pid: bigint; liquidity: bigint }[]; // open TegataMarket bid positions
};

export type Book = {
  chainTime: number;
  invoices: InvoiceRow[];
  me: { jpyc: bigint; verified: boolean; name: string; isOperator: boolean; jpycAllowanceMarket: bigint; jpycAllowanceRegistry: bigint };
  bandBps: bigint;
  baseRateBps: number;
};

export function useBook(dep: Deployment | undefined, s: Session | undefined, tick: number) {
  const [book, setBook] = useState<Book>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!dep || !s) return;
    let live = true;
    const r = (address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
      s.pub.readContract({ address, abi: abi as any, functionName, args } as any) as Promise<any>;
    const load = async () => {
      const block = await s.pub.getBlock();
      const now = Number(block.timestamp);
      const count = Number(await r(dep.registry, ABI.registry, 'invoiceCount'));
      const opRole = await r(dep.registry, ABI.registry, 'OPERATOR_ROLE');
      const [jpyc, verified, name, isOperator, aMarket, aRegistry, bandBps] = await Promise.all([
        r(dep.jpyc, ABI.jpyc, 'balanceOf', [s.account]),
        r(dep.registry, ABI.registry, 'isVerified', [s.account]),
        r(dep.registry, ABI.registry, 'companyName', [s.account]),
        r(dep.registry, ABI.registry, 'hasRole', [opRole, s.account]),
        r(dep.jpyc, ABI.jpyc, 'allowance', [s.account, dep.market]),
        r(dep.jpyc, ABI.jpyc, 'allowance', [s.account, dep.registry]),
        r(dep.hook, ABI.hook, 'bandBps'),
      ]);
      const baseRateBps = Number(await r(dep.risk, ABI.risk, 'baseRateBps'));
      const pids = (await r(dep.market, ABI.market, 'positionsOf', [s.account])) as bigint[];
      const positions = await Promise.all(
        pids.map(async (pid) => {
          const p = await r(dep.market, ABI.market, 'positions', [pid]);
          return { pid, invoiceId: Number(p[0]), liquidity: p[4] as bigint };
        }),
      );
      const invoices: InvoiceRow[] = [];
      for (let id = 1; id <= count; id++) {
        const inv = await r(dep.registry, ABI.registry, 'invoice', [BigInt(id)]);
        const [fair, tradable, poolCreated, supplierName, debtorName, myTokens, rateBps, debtorGrade] = await Promise.all([
          r(dep.registry, ABI.registry, 'fairPrice', [BigInt(id), BigInt(now)]),
          r(dep.registry, ABI.registry, 'isTradable', [BigInt(id)]),
          inv.status >= 2 ? r(dep.market, ABI.market, 'isPoolCreated', [BigInt(id)]).catch(() => false) : Promise.resolve(false),
          r(dep.registry, ABI.registry, 'companyName', [inv.supplier]),
          r(dep.registry, ABI.registry, 'companyName', [inv.debtor]),
          r(inv.token, ABI.token, 'balanceOf', [s.account]),
          r(dep.registry, ABI.registry, 'rateOf', [BigInt(id)]),
          r(dep.risk, ABI.risk, 'gradeOf', [inv.debtor]),
        ]);
        let poolPrice: bigint | undefined;
        let deviationBps: bigint | undefined;
        if (poolCreated) {
          const key = await r(dep.market, ABI.market, 'keyOf', [BigInt(id)]);
          poolPrice = await r(dep.hook, ABI.hook, 'poolPrice', [key]);
          deviationBps = await r(dep.hook, ABI.hook, 'deviationBps', [poolPrice, fair]);
        }
        invoices.push({
          id,
          supplier: inv.supplier,
          debtor: inv.debtor,
          supplierName,
          debtorName,
          token: inv.token,
          face: inv.face,
          maturity: Number(inv.maturity),
          rateBps: Number(rateBps),
          rateAtIssueBps: Number(inv.rateAtIssueBps),
          debtorGrade: Number(debtorGrade),
          frozen: inv.frozen,
          status: Number(inv.status),
          funded: inv.funded,
          tradable,
          fair,
          poolCreated,
          poolPrice,
          deviationBps,
          myTokens,
          myPositions: positions.filter((p) => p.invoiceId === id && p.liquidity > 0n),
        });
      }
      if (!live) return;
      setBook({ chainTime: now, invoices, bandBps, baseRateBps, me: { jpyc, verified, name, isOperator, jpycAllowanceMarket: aMarket, jpycAllowanceRegistry: aRegistry } });
      setErr(undefined);
    };
    load().catch((e) => live && setErr(String(e?.shortMessage ?? e?.message ?? e)));
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [dep, s, tick]);
  return { book, err };
}

export type TxStatus =
  | { kind: 'idle' }
  | { kind: 'pending'; label: string }
  | { kind: 'ok'; label: string; hash: string }
  | { kind: 'error'; label: string; revert: DecodedRevert };

export function useTx(s: Session | undefined, onDone: () => void) {
  const [status, setStatus] = useState<TxStatus>({ kind: 'idle' });
  const send = useCallback(
    async (label: string, address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) => {
      if (!s) return;
      setStatus({ kind: 'pending', label });
      try {
        const { request } = await s.pub.simulateContract({ account: s.account, address, abi: abi as any, functionName, args } as any);
        const hash = await s.wallet.writeContract({ ...(request as any), account: s.wallet.account ?? s.account });
        await s.pub.waitForTransactionReceipt({ hash });
        setStatus({ kind: 'ok', label, hash });
      } catch (e) {
        setStatus({ kind: 'error', label, revert: explainError(e) });
      } finally {
        onDone();
      }
    },
    [s, onDone],
  );
  return { status, send };
}
