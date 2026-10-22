// Fetches public web pages for website analysis without letting a URL reach private networks.
// Every hostname is resolved and checked at connect time (so DNS rebinding can't swap in a private
// address), redirects are re-validated hop by hop, and responses are capped in time and size.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export class UnsafeUrl extends Error {
  name = "UnsafeUrl";
}

export type Fetched = { url: string; status: number; contentType: string; body: string };
export type PageFetcher = (url: string) => Promise<Fetched>;

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.goog", "instance-data"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

function blockedV4(ip: string) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

// Expands an IPv6 address to eight 16-bit groups.
function ipv6Groups(ip: string): number[] {
  let addr = ip.toLowerCase().split("%")[0];
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = addr.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

function blockedV6(ip: string) {
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1 (and the old ::a.b.c.d form)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedV4(embeddedV4); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embeddedV4); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7, includes AWS fd00:ec2::254
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  if (g[0] === 0x2002) return blockedV4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`); // 6to4
  return false;
}

// True for any address a public website should never resolve to.
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip);
  return true;
}

// Checks the shape of a URL before any network access: public http(s) on the default ports only.
export function assertPublicUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UnsafeUrl("Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrl("Only http and https pages can be analysed.");
  if (url.username || url.password) throw new UnsafeUrl("URLs with credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrl("Only the standard web ports are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrl("That address is private or reserved.");
    return url;
  }
  if (!host.includes(".") || BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrl("That host name is not a public website.");
  }
  // Decimal, octal or hex IPv4 spellings such as 2130706433 or 0x7f.1 are parsed by URL into dotted form,
  // so they arrive above as IPs. Anything left that looks numeric is refused.
  if (/^[0-9.x]+$/i.test(host)) throw new UnsafeUrl("That host name is not a public website.");
  return url;
}

type LookupFn = (hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => void;

// A dns.lookup replacement used by the socket itself, so the address checked is the address connected to.
export function guardedLookup(resolve: typeof dnsLookup = dnsLookup): LookupFn {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (!list.length || bad) {
        const e = new UnsafeUrl(`${hostname} resolves to a private or reserved address.`) as unknown as NodeJS.ErrnoException;
        e.code = "EUNSAFEADDRESS";
        return callback(e, []);
      }
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  resolve?: typeof dnsLookup;
};

const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml|ld\+json|json))/i;

function requestOnce(url: URL, opts: Required<Omit<SafeFetchOptions, "resolve">> & { resolve?: typeof dnsLookup }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((done, fail) => {
    // One deadline for the whole request, so a server dripping bytes can't hold the scan open.
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${opts.timeoutMs / 1000}s`)), opts.timeoutMs);
    const resolve = (v: { status: number; headers: http.IncomingHttpHeaders; body: string }) => (clearTimeout(timer), done(v));
    const reject = (e: unknown) => (clearTimeout(timer), fail(e));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(opts.resolve) as unknown as typeof dnsLookup,
        headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8", "accept-encoding": "gzip, deflate, br" },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: "" });
        }
        if (type && !TEXT_TYPES.test(type)) {
          res.destroy();
          return resolve({ status, headers: res.headers, body: "" });
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          // Counted after decompression, so a small compressed bomb can't expand without limit.
          if (size > opts.maxBytes) {
            req.destroy();
            stream.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Fetches a public page. Redirects are followed only to other public URLs.
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<Fetched> {
  const opts = { timeoutMs: 8000, maxBytes: 1_500_000, maxRedirects: 3, userAgent: "RnROsBot/1.0", ...options };
  let url = assertPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, opts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= opts.maxRedirects) throw new Error("Too many redirects.");
      url = assertPublicUrl(new URL(res.headers.location, url));
      continue;
    }
    return { url: url.toString(), status: res.status, contentType: String(res.headers["content-type"] ?? ""), body: res.body };
  }
}

export function safeFetcher(options: SafeFetchOptions = {}): PageFetcher {
  return (url) => safeFetch(url, options);
}
