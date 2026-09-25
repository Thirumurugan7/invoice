// Allow the local web app to call MultiBaas Event Queries from the browser.
import * as MultiBaas from '@curvegrid/multibaas-sdk';
import { config } from './client.ts';
const admin = new MultiBaas.AdminApi(config());
const origin = process.argv[2] ?? 'http://localhost:5174';
const list = await admin.listCorsOrigins();
const existing = (list.data.result ?? []).map((o: any) => o.origin);
if (existing.includes(origin)) console.log(`CORS origin already allowed: ${origin}`);
else {
  await admin.addCorsOrigin({ origin, label: 'tegata-web-local' } as any);
  console.log(`CORS origin added: ${origin}`);
}
