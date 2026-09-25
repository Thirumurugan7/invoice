import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const names = { registry: 'InvoiceRegistry', risk: 'CreditRiskModel', hook: 'MaturityCurveHook', market: 'TegataMarket', token: 'InvoiceToken', jpyc: 'MockJPYC', customRevert: 'CustomRevert', hooks: 'Hooks' };
const abis = {};
for (const [k, n] of Object.entries(names)) {
  const f = resolve(root, `out/${n}.sol/${n}.json`);
  if (!existsSync(f)) throw new Error(`Missing ${f} — run forge build`);
  abis[k] = JSON.parse(readFileSync(f, 'utf8')).abi;
}
writeFileSync(resolve(root, 'web/src/generated/abis.json'), JSON.stringify(abis));
const dep = resolve(root, `deployments/${process.env.DEPLOY_CHAIN ?? '31337'}.json`);
if (existsSync(dep)) copyFileSync(dep, resolve(root, 'web/public/deployment.json'));
console.log('synced', Object.keys(abis).join(', '));
