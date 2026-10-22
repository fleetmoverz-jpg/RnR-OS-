// A fake Graph API for tests. Routes are "METHOD /path" without the version prefix; a handler returns
// { status, body, headers } or throws to simulate a network failure. Every call is recorded.
export type MetaCall = { method: string; path: string; params: URLSearchParams };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (params: URLSearchParams, call: number) => Reply;

export function mockMeta(routes: Record<string, Handler>) {
  const calls: MetaCall[] = [];
  const counts = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const params = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    calls.push({ method, path, params });
    const key = `${method} ${path}`;
    const handler = routes[key];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (!handler) return new Response(JSON.stringify({ error: { message: `No mock for ${key}`, code: 100 } }), { status: 400 });
    const r = handler(params, n);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  };
  return { fetch, calls, count: (key: string) => counts.get(key) ?? 0 };
}

export const graphError = (status: number, code: number, message = "Mocked error", subcode?: number): Reply => ({ status, body: { error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: "trace" } } });

// A JPEG header (SOI, APP0, SOF0) with the given size; enough for imageInfo.
export function jpegBytes(width: number, height: number, pad = 64) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, ...new Array(pad).fill(0)]);
}

export function pngBytes(width: number, height: number) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
