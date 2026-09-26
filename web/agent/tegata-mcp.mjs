// Read-only MCP server for the AI operations desk: live Tegata data straight from the chain.
// Claude Code launches it over stdio (see vite.config.ts). Every tool is a view call; there is no signer, so it can't
// send transactions.
//   TEGATA_DEPLOYMENT  deployment.json the app is using (chainId + contract addresses)
//   TEGATA_RPC_URL     RPC for that chain
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPublicClient, fallback, http, isAddress, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(process.env.TEGATA_DEPLOYMENT ?? resolve(here, '../public/deployment.json'), 'utf8'));
const ABI = JSON.parse(readFileSync(resolve(here, '../src/generated/abis.json'), 'utf8'));
const rpc = process.env.TEGATA_RPC_URL ?? (dep.chainId === 11155111 ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'http://127.0.0.1:8546');
// On Sepolia, fail over between public RPCs (they rate-limit per IP) and batch reads through Multicall3.
const pub = dep.chainId === 11155111
  ? createPublicClient({
      chain: sepolia,
      transport: fallback([...new Set([rpc, 'https://1rpc.io/sepolia', 'https://sepolia.gateway.tenderly.co'])].map((url) => http(url))),
      batch: { multicall: true },
    })
  : createPublicClient({ transport: http(rpc) });
const r = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

const STATUS = ['None', 'Pending', 'Accepted', 'Rejected', 'Settled', 'Defaulted'];
const yen = (wei) => `¥${(Number(BigInt(wei) / 10n ** 16n) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}`;
const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;
const price = (v) => (Number(v) / 1e18).toFixed(5);
const jst = (sec) => new Date(Number(sec) * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST';
const network = dep.chainId === 11155111 ? 'Sepolia (real JPYC)' : `local chain ${dep.chainId}`;

async function chainTime() {
  return Number((await pub.getBlock()).timestamp);
}

async function invoice(id, now) {
  const inv = await r(dep.registry, ABI.registry, 'invoice', [BigInt(id)]);
  if (Number(inv.status) === 0) throw new Error(`Invoice #${id} does not exist.`);
  const [ref, supplierName, debtorName, supplierRated, debtorRated, debtorGrade, rateBps, fair, tradable] = await Promise.all([
    r(dep.registry, ABI.registry, 'invoiceRef', [BigInt(id)]),
    r(dep.registry, ABI.registry, 'companyName', [inv.supplier]),
    r(dep.registry, ABI.registry, 'companyName', [inv.debtor]),
    r(dep.risk, ABI.risk, 'isRated', [inv.supplier]),
    r(dep.risk, ABI.risk, 'isRated', [inv.debtor]),
    r(dep.risk, ABI.risk, 'gradeFor', [inv.debtor]),
    r(dep.registry, ABI.registry, 'rateOf', [BigInt(id)]),
    r(dep.registry, ABI.registry, 'fairPrice', [BigInt(id), BigInt(now)]),
    r(dep.registry, ABI.registry, 'isTradable', [BigInt(id)]),
  ]);
  const status = STATUS[Number(inv.status)];
  let pool = { created: false };
  if (Number(inv.status) >= 2 && (await r(dep.market, ABI.market, 'isPoolCreated', [BigInt(id)]).catch(() => false))) {
    const key = await r(dep.market, ABI.market, 'keyOf', [BigInt(id)]);
    const poolPrice = await r(dep.hook, ABI.hook, 'poolPrice', [key]);
    const deviation = await r(dep.hook, ABI.hook, 'deviationBps', [poolPrice, fair]);
    pool = { created: true, price: price(poolPrice), deviationFromCurve: `${deviation} bps` };
  }
  const acceptNeed = Number(inv.status) === 1 ? await r(dep.vault, ABI.vault, 'required', [inv.debtor, inv.face]) : undefined;
  const label = (name, addr, rated) => ({ address: addr, name: name || null, identity: rated ? 'rated by the operator' : 'unverified (self-declared name)' });
  return {
    id: Number(id),
    reference: ref,
    status,
    frozen: inv.frozen,
    tradable,
    supplier: label(supplierName, inv.supplier, supplierRated),
    debtor: { ...label(debtorName, inv.debtor, debtorRated), grade: debtorRated ? `G${debtorGrade}` : `unrated (priced as G${debtorGrade})` },
    faceValue: yen(inv.face),
    paid: yen(inv.funded),
    issued: jst(inv.issuedAt),
    maturity: jst(inv.maturity),
    daysToMaturity: Number(((Number(inv.maturity) - now) / 86400).toFixed(1)),
    rate: pct(rateBps),
    rateAtRegistration: pct(inv.rateAtIssueBps),
    fairPricePerYen: status === 'Settled' ? '1.00000 (redeems 1:1)' : status === 'Defaulted' ? `${price((inv.funded * 10n ** 18n) / inv.face)} (pro-rata recovery)` : price(fair),
    pool,
    ...(acceptNeed !== undefined ? { collateralDebtorMustHoldToAccept: yen(acceptNeed) } : {}),
  };
}

async function allInvoices(now) {
  const count = Number(await r(dep.registry, ABI.registry, 'invoiceCount'));
  return Promise.all(Array.from({ length: count }, (_, k) => invoice(k + 1, now)));
}

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] });
const safe = (fn) => async (args) => {
  try {
    return json(await fn(args ?? {}));
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e?.shortMessage ?? e?.message ?? e}` }], isError: true };
  }
};
const readOnly = { readOnlyHint: true, openWorldHint: false };

const server = new McpServer({ name: 'tegata', version: '1.0.0' });

server.registerTool(
  'get_overview',
  {
    description: `Protocol and portfolio overview on ${network}: chain time, pricing rules, collateral policy, reward pool, and invoice counts and outstanding face by status.`,
    annotations: readOnly,
  },
  safe(async () => {
    const now = await chainTime();
    const [baseRate, band, apr, reserve, ...required] = await Promise.all([
      r(dep.risk, ABI.risk, 'baseRateBps'),
      r(dep.hook, ABI.hook, 'bandBps'),
      r(dep.vault, ABI.vault, 'aprBps'),
      r(dep.vault, ABI.vault, 'rewardReserve'),
      ...[0, 1, 2, 3, 4, 5].map((g) => r(dep.vault, ABI.vault, 'requiredBps', [BigInt(g)])),
    ]);
    const invoices = await allInvoices(now);
    const byStatus = Object.fromEntries(STATUS.slice(1).map((s) => [s, invoices.filter((i) => i.status === s).length]));
    return {
      network,
      chainTime: jst(now),
      pricing: {
        rule: 'rate = base + grade spread (G1 1%, G2 2%, G3 4%, G4 8%, G5 16%) + 10% per default + 1% per late payment − 0.1% per on-time settlement (max 1%) − up to 2% for collateral coverage; unrated debtors are priced as G5',
        baseRate: pct(baseRate),
        curveBand: `±${band} bps (the Uniswap hook blocks trades that push the price further off the curve)`,
      },
      collateral: {
        requiredToAccept: Object.fromEntries(required.map((b, g) => [g === 0 ? 'unrated' : `G${g}`, pct(b)])),
        aprOnBackingCollateral: pct(apr),
        rewardPool: yen(reserve),
      },
      invoicesByStatus: byStatus,
      invoiceIds: invoices.map((i) => i.id),
    };
  }),
);

server.registerTool(
  'list_invoices',
  {
    description: 'List invoices with parties, amounts, maturity, status, rate, fair price and pool state. Optionally filter by status.',
    inputSchema: { status: z.enum(['Pending', 'Accepted', 'Rejected', 'Settled', 'Defaulted']).optional() },
    annotations: readOnly,
  },
  safe(async ({ status }) => {
    const now = await chainTime();
    const invoices = await allInvoices(now);
    return { chainTime: jst(now), invoices: status ? invoices.filter((i) => i.status === status) : invoices };
  }),
);

server.registerTool(
  'get_invoice',
  {
    description: 'Full live detail of one invoice by id, including the on-chain invoice record (contractURI JSON).',
    inputSchema: { id: z.number().int().positive() },
    annotations: readOnly,
  },
  safe(async ({ id }) => {
    const now = await chainTime();
    const detail = await invoice(id, now);
    const token = (await r(dep.registry, ABI.registry, 'invoice', [BigInt(id)])).token;
    const uri = await r(token, ABI.token, 'contractURI');
    let record;
    try {
      record = JSON.parse(uri.slice(uri.indexOf(',') + 1));
    } catch {
      record = 'unparseable (a company name contains a control character)';
    }
    return { chainTime: jst(now), ...detail, token, onChainRecord: record };
  }),
);

server.registerTool(
  'get_company',
  {
    description: 'Credit, collateral and invoice position of a company by wallet address: name, rating, live rate, payment history, amount owed, collateral (locked/free), interest, and its invoices as supplier and debtor.',
    inputSchema: { address: z.string() },
    annotations: readOnly,
  },
  safe(async ({ address }) => {
    if (!isAddress(address)) throw new Error('Not a valid address.');
    const a = getAddress(address);
    const now = await chainTime();
    const [name, rated, grade, rateBps, history, outstanding, collateral, locked, stake, interest, requiredBps, coverageBps, jpyc] = await Promise.all([
      r(dep.registry, ABI.registry, 'companyName', [a]),
      r(dep.risk, ABI.risk, 'isRated', [a]),
      r(dep.risk, ABI.risk, 'gradeFor', [a]),
      r(dep.risk, ABI.risk, 'rateBps', [a]),
      r(dep.risk, ABI.risk, 'historyOf', [a]),
      r(dep.registry, ABI.registry, 'outstandingOf', [a]),
      r(dep.vault, ABI.vault, 'collateralOf', [a]),
      r(dep.vault, ABI.vault, 'lockedOf', [a]),
      r(dep.vault, ABI.vault, 'stakeOf', [a]),
      r(dep.vault, ABI.vault, 'interestOf', [a]),
      r(dep.vault, ABI.vault, 'requiredBpsFor', [a]),
      r(dep.vault, ABI.vault, 'coverageBps', [a]),
      r(dep.jpyc, ABI.jpyc, 'balanceOf', [a]),
    ]);
    const invoices = await allInvoices(now);
    const mine = (role) => invoices.filter((i) => i[role].address.toLowerCase() === a.toLowerCase()).map((i) => ({ id: i.id, reference: i.reference, status: i.status, faceValue: i.faceValue, maturity: i.maturity }));
    return {
      address: a,
      name: name || null,
      identity: rated ? 'rated by the operator' : 'unverified (self-declared name)',
      grade: rated ? `G${grade}` : `unrated (priced as G${grade})`,
      rate: pct(rateBps),
      paymentHistory: { onTime: Number(history[0]), late: Number(history[1]), defaults: Number(history[2]) },
      owedOnAcceptedInvoices: yen(outstanding),
      collateral: { deposited: yen(collateral), locked: yen(locked), free: yen(collateral - locked), coverage: pct(coverageBps), requiredToAccept: pct(requiredBps) },
      collateralInterest: { earningOn: yen(stake), accrued: yen(interest) },
      jpycBalance: yen(jpyc),
      invoicesAsSupplier: mine('supplier'),
      invoicesAsDebtor: mine('debtor'),
    };
  }),
);

await server.connect(new StdioServerTransport());
