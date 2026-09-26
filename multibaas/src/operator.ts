// Platform operator actions through MultiBaas.
//   Mode A (production): MB_HSM_ADDRESS set -> MultiBaas Cloud Wallet (HSM) signs and submits (signAndSubmit).
//   Mode B (default, no HSM): MultiBaas builds the unsigned tx, the operator key (OPERATOR_PK) signs it locally,
//          MultiBaas submits it (ChainsApi.submitSignedTransaction). The key never goes to MultiBaas.
//
//   npm run operator -- freeze <invoiceId> <true|false>
//   npm run operator -- default <invoiceId>
//   npm run operator -- rate <debtor> <grade 1..5>      (CreditRiskModel: reprices all the debtor's invoices)
//   npm run operator -- base <bps>                      (CreditRiskModel base rate)
//   npm run operator -- apr <bps>                       (CollateralVault: APR paid on locked collateral, max 2000)
//   npm run operator -- require <grade 0..5> <bps>      (CollateralVault: collateral needed to ACCEPT; grade 0 = unrated)
//   npm run operator -- wallets
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { config, LABELS } from './client.ts';

const cfg = config();
const contracts = new MultiBaas.ContractsApi(cfg);
const chains = new MultiBaas.ChainsApi(cfg);
const hsm = new MultiBaas.HsmApi(cfg);
const hsmAddress = process.env.MB_HSM_ADDRESS;
const operatorPk = process.env.OPERATOR_PK as `0x${string}` | undefined;
const [cmd, ...args] = process.argv.slice(2);

/// Wait until MultiBaas sees the transaction mined, and fail loudly if it reverted. Waiting also means the next
/// command is built on the updated nonce and state (back-to-back commands otherwise race the pending transaction).
async function waitMined(hash: string) {
  for (let i = 0; i < 60; i++) {
    const receipt = await chains
      .getTransactionReceipt(hash)
      .then((r) => r.data.result.data)
      .catch((e) => (e?.response?.status === 404 ? undefined : Promise.reject(e)));
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`transaction ${hash} reverted`);
      console.log(`  mined: ${hash}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`transaction ${hash} not mined after 3 minutes`);
}

async function send(method: string, fnArgs: unknown[], alias: string = LABELS.registry) {
  if (hsmAddress) {
    const res = await contracts.callContractFunction(alias, alias, method, {
      args: fnArgs as any[],
      from: hsmAddress,
      signAndSubmit: true,
      nonceManagement: true,
    });
    const hash = (res.data.result as any)?.tx?.hash;
    console.log(`${method}: signed by Cloud Wallet ${hsmAddress}`, JSON.stringify(hash ?? res.data.result));
    if (hash) await waitMined(hash);
    return;
  }
  if (!operatorPk) throw new Error('Set MB_HSM_ADDRESS (Cloud Wallet) or OPERATOR_PK (local operator key) in multibaas/.env');
  const account = privateKeyToAccount(operatorPk);
  // 1. MultiBaas builds the transaction (ABI encoding, nonce, gas, fees).
  const res = await contracts.callContractFunction(alias, alias, method, { args: fnArgs as any[], from: account.address });
  const result = res.data.result as any;
  if (result.kind !== 'TransactionToSignResponse') throw new Error(`expected a transaction, got ${result.kind}`);
  const tx = result.tx as MultiBaas.TransactionToSignTx;
  const chainId = (await chains.getChainStatus()).data.result.chainID;
  // 2. Sign locally.
  const signedTx = await account.signTransaction({
    chainId,
    type: 'eip1559',
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.gasFeeCap ?? tx.gasPrice ?? '0'),
    maxPriorityFeePerGas: BigInt(tx.gasTipCap ?? '0'),
    to: tx.to as `0x${string}`,
    value: BigInt(tx.value ?? '0'),
    data: tx.data as `0x${string}`,
  });
  // 3. MultiBaas submits and tracks it.
  const sub = await chains.submitSignedTransaction({ signedTx });
  const hash = (sub.data.result as any).tx.hash as string;
  console.log(`${method}: built by MultiBaas, signed by operator ${account.address}, submitted via MultiBaas: ${hash}`);
  // 4. Wait for it to be mined (MultiBaas receipt).
  await waitMined(hash);
}

switch (cmd) {
  case 'wallets': {
    const w = await hsm.listHsmWallets();
    console.log(JSON.stringify(w.data.result, null, 2));
    break;
  }
  case 'freeze':
    await send('setFrozen', [args[0], args[1] !== 'false']);
    break;
  case 'default':
    await send('markDefault', [args[0]]);
    break;
  case 'rate':
    await send('rate', [args[0], Number(args[1])], LABELS.risk);
    break;
  case 'apr':
    await send('setAprBps', [Number(args[0])], LABELS.vault);
    break;
  case 'require':
    await send('setRequiredBps', [Number(args[0]), Number(args[1])], LABELS.vault);
    break;
  case 'base':
    await send('setBaseRate', [Number(args[0])], LABELS.risk);
    break;
  default:
    console.log('usage: operator wallets | freeze <id> <true|false> | default <id> | rate <debtor> <grade> | base <bps> | apr <bps> | require <grade> <bps>');
}
