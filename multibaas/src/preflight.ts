// Pre-deploy MultiBaas setup: ABI library + link the shared Uniswap v4 PoolManager (Sepolia) + Cloud Wallet check.
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { baseContract, config, idempotent, LABELS } from './client.ts';

const cfg = config();
const contracts = new MultiBaas.ContractsApi(cfg);
const addresses = new MultiBaas.AddressesApi(cfg);
const chains = new MultiBaas.ChainsApi(cfg);
const hsm = new MultiBaas.HsmApi(cfg);
const POOL_MANAGER_SEPOLIA = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';

const status = (await chains.getChainStatus()).data.result;
console.log(`MultiBaas chain ${status.chainID} @ block ${status.blockNumber}`);

for (const [label, name] of [
  [LABELS.registry, 'InvoiceRegistry'],
  [LABELS.risk, 'CreditRiskModel'],
  [LABELS.vault, 'CollateralVault'],
  [LABELS.hook, 'MaturityCurveHook'],
  [LABELS.market, 'TegataMarket'],
  [LABELS.invoiceToken, 'InvoiceToken'],
  [LABELS.poolManager, 'PoolManager'],
] as const) {
  await idempotent(contracts.createContract(label, baseContract(label, name)), `abi ${label}`);
}

const from = String(status.blockNumber - 50);
await idempotent(addresses.setAddress({ alias: LABELS.poolManager, address: POOL_MANAGER_SEPOLIA }), `alias ${LABELS.poolManager}`);
await idempotent(
  contracts.linkAddressContract(LABELS.poolManager, { label: LABELS.poolManager, version: '1.0', startingBlock: from }),
  `link+sync ${LABELS.poolManager} from block ${from}`,
);

try {
  const w = await hsm.listHsmWallets();
  console.log('Cloud Wallets (HSM):', JSON.stringify(w.data.result ?? []).slice(0, 300));
} catch (e: any) {
  console.log('Cloud Wallets: not available on this deployment', e?.response?.status ?? '', JSON.stringify(e?.response?.data ?? '').slice(0, 200));
}
