// MultiBaas webhook receiver (event.emitted).
// - Verifies X-MultiBaas-Signature = hex(HMAC-SHA256(secret, body || timestamp)) per the MultiBaas docs.
// - InvoiceRegistered  -> links the new invoice token in MultiBaas (alias tegata_invoice_<id>) so its Transfer
//                         events are indexed immediately (holder registry for the receivables book).
// - InvoiceRegistered  -> notifies the debtor to accept; InvoiceSettled/Defaulted -> notifies holders to redeem.
// NOTE: the exact event.emitted `data` shape is read defensively (name + inputs); verify against a live payload.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { deployment, invoiceAlias, LABELS, linkAlias } from './client.ts';

const secret = process.env.WEBHOOK_SECRET ?? '';
const port = Number(process.env.WEBHOOK_PORT ?? 8787);
const d = deployment();

export function verifySignature(body: Buffer, timestamp: string, signature: string): boolean {
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(body).update(timestamp).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature ?? '', 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

type Input = { name?: string; value?: unknown };
function eventFields(data: any): { name: string; inputs: Record<string, unknown>; address?: string } {
  const ev = data?.event ?? data;
  const name: string = ev?.name ?? ev?.signature?.split('(')[0] ?? '';
  const inputs: Record<string, unknown> = {};
  for (const i of (ev?.inputs ?? []) as Input[]) if (i?.name) inputs[i.name] = i.value;
  return { name, inputs, address: data?.contract?.address ?? ev?.contract?.address };
}

async function onEvent(data: any) {
  const { name, inputs } = eventFields(data);
  switch (name) {
    case 'InvoiceRegistered': {
      const id = String(inputs.id);
      const token = String(inputs.token);
      console.log(`[registered] invoice #${id} face=${inputs.face} debtor=${inputs.debtor} -> ask debtor to accept`);
      await linkAlias(invoiceAlias(id), token, LABELS.invoiceToken, d.startBlock);
      break;
    }
    case 'InvoiceAccepted':
      console.log(`[accepted] invoice #${inputs.id} is now a tradable claim (pool can be created on its curve)`);
      break;
    case 'InvoiceSettled':
      console.log(`[settled] invoice #${inputs.id} fully paid -> notify holders to redeem 1:1`);
      break;
    case 'InvoiceDefaulted':
      console.log(`[defaulted] invoice #${inputs.id} funded ${inputs.funded}/${inputs.face} -> holders redeem pro-rata`);
      break;
    case 'DebtorRated':
      console.log(`[credit] ${inputs.debtor} rated G${inputs.grade} -> rate ${Number(inputs.rateBps) / 100}%: every open invoice of this debtor repriced`);
      break;
    case 'CreditEventRecorded':
      console.log(`[credit] ${inputs.debtor} ${['paid on time', 'paid late', 'DEFAULTED'][Number(inputs.kind)]} on #${inputs.invoiceId} -> rate ${Number(inputs.rateBps) / 100}%`);
      break;
    case 'CurveTrade':
      console.log(`[trade] invoice #${inputs.invoiceId} price=${inputs.price} fair=${inputs.fair} dev=${inputs.deviationBps}bps`);
      break;
    default:
      if (name) console.log(`[event] ${name}`);
  }
}

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200).end('tegata webhook receiver');
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const ok = verifySignature(body, String(req.headers['x-multibaas-timestamp'] ?? ''), String(req.headers['x-multibaas-signature'] ?? ''));
    if (!ok) {
      res.writeHead(401).end('bad signature');
      return;
    }
    res.writeHead(200).end('ok');
    for (const item of JSON.parse(body.toString()) as any[]) {
      if (item.event === 'event.emitted') await onEvent(item.data).catch((e) => console.error(e));
    }
  });
}).listen(port, () => console.log(`webhook receiver on :${port}`));
