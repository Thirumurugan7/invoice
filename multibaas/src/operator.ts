// Platform operator actions through MultiBaas.
//   Mode A (production): MB_HSM_ADDRESS set -> MultiBaas Cloud Wallet (HSM) signs and submits (signAndSubmit).
//   Mode B (default, no HSM): MultiBaas builds the unsigned tx, the operator key (OPERATOR_PK) signs it locally,
//          MultiBaas submits it (ChainsApi.submitSignedTransaction). The key never goes to MultiBaas.
//
//   npm run operator -- verify <address> <法人番号> "<company name>"
//   npm run operator -- freeze <invoiceId> <true|false>
//   npm run operator -- default <invoiceId>
//   npm run operator -- wallets
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { config, LABELS } from './client.ts';

const cfg = config();
const contracts = new MultiBaas.ContractsApi(cfg);
const chains = new MultiBaas.ChainsApi(cfg);
const hsm = new MultiBaas.HsmApi(cfg);
const hsmAddress = process.env.MB_HSM_ADDRESS;
const operatorPk = process.env.OPERATOR_PK as `0x${string}` | undefined;
const [cmd, ...args] = process.argv.slice(2);

/// Deterministic hash of the corporate number so the raw 法人番号 never goes on-chain.
const corpIdHash = (corpNumber: string) => '0x' + createHash('sha256').update(`corp:${corpNumber.trim()}`).digest('hex');

async function send(method: string, fnArgs: unknown[]) {
  if (hsmAddress) {
    const res = await contracts.callContractFunction(LABELS.registry, LABELS.registry, method, {
      args: fnArgs as any[],
      from: hsmAddress,
      signAndSubmit: true,
      nonceManagement: true,
    });
    console.log(`${method}: signed by Cloud Wallet ${hsmAddress}`, JSON.stringify((res.data.result as any)?.tx?.hash ?? res.data.result));
    return;
  }
  if (!operatorPk) throw new Error('Set MB_HSM_ADDRESS (Cloud Wallet) or OPERATOR_PK (local operator key) in multibaas/.env');
  const account = privateKeyToAccount(operatorPk);
  // 1. MultiBaas builds the transaction (ABI encoding, nonce, gas, fees).
  const res = await contracts.callContractFunction(LABELS.registry, LABELS.registry, method, { args: fnArgs as any[], from: account.address });
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
  console.log(`${method}: built by MultiBaas, signed by operator ${account.address}, submitted via MultiBaas`, JSON.stringify(sub.data.result));
}

switch (cmd) {
  case 'wallets': {
    const w = await hsm.listHsmWallets();
    console.log(JSON.stringify(w.data.result, null, 2));
    break;
  }
  case 'verify': {
    const [address, corpNumber, ...name] = args;
    await send('verifyCompany', [address, corpIdHash(corpNumber), name.join(' ')]);
    break;
  }
  case 'freeze':
    await send('setFrozen', [args[0], args[1] !== 'false']);
    break;
  case 'default':
    await send('markDefault', [args[0]]);
    break;
  default:
    console.log('usage: operator wallets | verify <addr> <corpNumber> <name> | freeze <id> <true|false> | default <id>');
}
