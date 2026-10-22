// A fake fetch that answers like Google's OAuth and Search Console endpoints, and records every call.
export type Call = { url: string; method: string; body: URLSearchParams | null; auth: string | null };
type Reply = { status?: number; body?: unknown };
type Handler = (call: Call) => Reply;

export function mockGoogle(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" || init?.body instanceof URLSearchParams ? new URLSearchParams(String(init.body)) : null,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const key = [...queues.keys()].find((k) => url.startsWith(k));
    if (!key) throw new Error(`Unexpected request to ${url}`);
    const entry = queues.get(key)!;
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
    const { status = 200, body = {} } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export function idToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.signature`;
}

export const GSC = "https://www.googleapis.com/auth/webmasters.readonly";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
