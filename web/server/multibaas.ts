// Server-side MultiBaas proxy for the receivables book. The API key stays on the server; the browser can only run
// read-only Event Queries (POST /api/v0/queries), nothing else. Shared by vite.config.ts and api/mb/query.ts.
export type MultiBaasEnv = { baseUrl?: string; apiKey?: string };
type Reply = { status: number; body: unknown };

export async function multibaasQuery(env: MultiBaasEnv, input: any): Promise<Reply> {
  if (!env.baseUrl || !env.apiKey) return { status: 503, body: { error: 'MultiBaas is not configured on this server.' } };
  const query = input?.query;
  if (!query || typeof query !== 'object' || !Array.isArray(query.events) || query.events.length === 0 || query.events.length > 4) {
    return { status: 400, body: { error: 'Expected an Event Query with 1 to 4 events.' } };
  }
  const offset = Number(input?.offset ?? 0);
  const limit = Number(input?.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { status: 400, body: { error: 'offset must be 0 to 10000 and limit 1 to 50.' } };
  }
  const url = new URL('/api/v0/queries', env.baseUrl);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify(query),
  });
  const body = await response.json().catch(() => ({ error: `MultiBaas returned ${response.status}` }));
  return { status: response.status, body };
}
