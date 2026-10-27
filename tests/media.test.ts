// Image checks before publishing: header parsing, type, size and shape rules per platform.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkImage, imageInfo } from "../src/lib/social/publish/media";
import { jpegBytes, pngBytes } from "./support/mock-meta";
import type { Fetched } from "../src/lib/social/safeFetch";

const serve = (bytes: Buffer, extra: Partial<Fetched> = {}) => async (url: string): Promise<Fetched> => ({ url, status: 200, contentType: "image/jpeg", body: "", bytes, truncated: false, ...extra });

describe("image headers", () => {
  test("reads JPEG, PNG, GIF and WebP sizes", () => {
    assert.deepEqual(imageInfo(jpegBytes(1080, 1350)), { mime: "image/jpeg", width: 1080, height: 1350 });
    assert.deepEqual(imageInfo(pngBytes(640, 480)), { mime: "image/png", width: 640, height: 480 });
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    assert.deepEqual(imageInfo(gif), { mime: "image/gif", width: 320, height: 240 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    assert.deepEqual(imageInfo(webp), { mime: "image/webp", width: 800, height: 600 });
    assert.equal(imageInfo(Buffer.from("<html>not an image</html>")), null);
  });
});

describe("platform image rules", () => {
  test("Instagram accepts a square or 4:5 JPEG", async () => {
    const r = await checkImage("https://cdn.test/a.jpg", "instagram", serve(jpegBytes(1080, 1350)));
    assert.equal(r.ok, true);
    assert.deepEqual([r.mime, r.width, r.height], ["image/jpeg", 1080, 1350]);
  });

  test("Instagram rejects PNG, too tall or too wide, and oversized files", async () => {
    assert.match((await checkImage("https://cdn.test/a.png", "instagram", serve(pngBytes(1080, 1080)))).errors[0], /needs JPEG; this image is PNG/);
    assert.match((await checkImage("https://cdn.test/a.jpg", "instagram", serve(jpegBytes(1080, 1920)))).errors[0], /between 4:5/);
    assert.match((await checkImage("https://cdn.test/a.jpg", "instagram", serve(jpegBytes(2000, 1000)))).errors[0], /between 4:5/);
    assert.match((await checkImage("https://cdn.test/a.jpg", "instagram", serve(jpegBytes(1080, 1080), { truncated: true }))).errors.join(" "), /larger than 8 MB/);
    assert.ok((await checkImage("https://cdn.test/a.jpg", "instagram", serve(jpegBytes(200, 200)))).warnings.some((w) => w.includes("upscale")));
  });

  test("Facebook takes PNG; links must be https, reachable and an image", async () => {
    assert.equal((await checkImage("https://cdn.test/a.png", "facebook_page", serve(pngBytes(1200, 630)))).ok, true);
    assert.match((await checkImage("http://cdn.test/a.png", "facebook_page", serve(pngBytes(1, 1)))).errors[0], /https/);
    assert.match((await checkImage("https://cdn.test/a.png", "facebook_page", serve(Buffer.alloc(0), { status: 404 }))).errors[0], /HTTP 404/);
    assert.match((await checkImage("https://cdn.test/a", "facebook_page", serve(Buffer.from("<html>")))).errors[0], /isn't a JPEG/);
    assert.match((await checkImage("https://cdn.test/a", "facebook_page", async () => { throw new Error("Blocked private address"); })).errors[0], /Blocked private address/);
    assert.match((await checkImage("https://cdn.test/a.jpg", "x", serve(jpegBytes(10, 10)))).errors[0], /aren't supported/);
  });
});
