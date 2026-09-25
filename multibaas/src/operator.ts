// Platform operator actions signed by a MultiBaas Cloud Wallet (HSM key) — no private key leaves the vault.
//   npm run operator -- wallets
//   npm run operator -- verify <address> <法人番号> "<company name>"
//   npm run operator -- freeze <invoiceId> <true|false>
//   npm run operator -- default <invoiceId>
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { createHash } from 'node:crypto';
import { config, LABELS } from './client.ts';

const cfg = config();
const contracts = new MultiBaas.ContractsApi(cfg);
const hsm = new MultiBaas.HsmApi(cfg);
const from = process.env.MB_HSM_ADDRESS;
const [cmd, ...args] = process.argv.slice(2);

/// Hash the corporate number so the registry never stores the raw identifier on-chain.
const corpIdHash = (corpNumber: string) => '0x' + createHash('sha256').update(`corp:${corpNumber.trim()}`).digest('hex');

async function send(method: string, fnArgs: unknown[]) {
  if (!from) throw new Error('Set MB_HSM_ADDRESS (a Cloud Wallet address with OPERATOR_ROLE)');
  const res = await contracts.callContractFunction(LABELS.registry, LABELS.registry, method, {
    args: fnArgs as any[],
    from,
    signAndSubmit: true, // MultiBaas signs with the HSM key and submits
    nonceManagement: true,
  });
  const result: any = res.data.result;
  console.log(`${method} submitted by Cloud Wallet ${from}:`, result?.tx?.hash ?? result);
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
