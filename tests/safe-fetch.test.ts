import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertPublicUrl, guardedLookup, isBlockedAddress, safeFetch, UnsafeUrl } from "../src/lib/social/safeFetch";

test("private, loopback, link-local, metadata and reserved addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:db8::1", "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("only public http(s) URLs on standard ports are accepted", () => {
  for (const bad of [
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com", "http://localhost/", "http://foo.localhost/", "http://127.0.0.1/",
    "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/", "http://user:pw@example.com/", "http://example.com:8080/", "http://intranet/", "http://printer.local/",
    "http://10.0.0.5/", "not a url",
  ]) {
    assert.throws(() => assertPublicUrl(bad), UnsafeUrl, bad);
  }
  assert.equal(assertPublicUrl("https://www.example.com/services?x=1").hostname, "www.example.com");
  assert.equal(assertPublicUrl("http://example.com:80/").hostname, "example.com");
});

test("the connect-time lookup refuses hostnames that resolve to private addresses (DNS rebinding)", async () => {
  const fakeDns = (answers: { address: string; family: number }[]) =>
    ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, answers)) as never;
  const run = (answers: { address: string; family: number }[], all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => guardedLookup(fakeDns(answers))("site.test", { all }, (err, address) => resolve({ err, address })));

  const bad = await run([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }], false);
  assert.equal(bad.err?.code, "EUNSAFEADDRESS", "one private answer is enough to refuse");
  const ok = await run([{ address: "93.184.216.34", family: 4 }], false);
  assert.equal(ok.err, null);
  assert.equal(ok.address, "93.184.216.34");
  const okAll = await run([{ address: "2606:4700::1", family: 6 }], true);
  assert.deepEqual(okAll.address, [{ address: "2606:4700::1", family: 6 }]);
});

test("safeFetch never reaches a local server, by IP or by a hostname resolving to it", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end("secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), UnsafeUrl);
    await assert.rejects(safeFetch("http://127.0.0.1/"), UnsafeUrl);
    const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;
    await assert.rejects(safeFetch("http://rebind.example.com/", { resolve: toLoopback }), /private or reserved/);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});
