// Checks an image URL before it's handed to a platform: reachable over public https, a supported type,
// within the size limit and with acceptable dimensions. The bytes are fetched through the SSRF guard.
import type { Fetched } from "../safeFetch";

export type ImageInfo = { mime: string; width: number; height: number };
export type ImageCheck = { url: string; ok: boolean; mime: string | null; width: number | null; height: number | null; bytes: number | null; errors: string[]; warnings: string[]; checked_at: string };
export type ImageFetcher = (url: string) => Promise<Fetched>;

// Reads the type and pixel size from the file header (JPEG, PNG, GIF, WebP).
export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mime: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size (C0-CF except C4 DHT, C8 JPG, CC DAC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

// Instagram: JPEG only, up to 8 MB, aspect ratio between 4:5 and 1.91:1 (IG User Media reference).
// Facebook Page photos: JPEG, PNG, GIF; Meta recommends under 4 MB.
export const MEDIA_RULES: Record<string, { types: string[]; maxBytes: number; warnBytes?: number; minRatio?: number; maxRatio?: number; minWidth?: number }> = {
  instagram: { types: ["image/jpeg"], maxBytes: 8 * 1024 * 1024, minRatio: 0.8, maxRatio: 1.91, minWidth: 320 },
  facebook_page: { types: ["image/jpeg", "image/png", "image/gif"], maxBytes: 10 * 1024 * 1024, warnBytes: 4 * 1024 * 1024 },
};

export async function checkImage(url: string, platform: string, fetcher: ImageFetcher, now = new Date()): Promise<ImageCheck> {
  const base = { url, mime: null, width: null, height: null, bytes: null, warnings: [] as string[], checked_at: now.toISOString() };
  if (!/^https:\/\//i.test(url)) return { ...base, ok: false, errors: ["Image links must start with https:// so the platform can fetch them."] };
  const rule = MEDIA_RULES[platform];
  if (!rule) return { ...base, ok: false, errors: [`Images aren't supported for ${platform} yet.`] };
  let res: Fetched;
  try {
    res = await fetcher(url);
  } catch (e) {
    return { ...base, ok: false, errors: [`The image couldn't be fetched: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (res.status !== 200) return { ...base, ok: false, errors: [`The image link returned HTTP ${res.status}. It must be publicly reachable.`] };
  const bytes = res.bytes ?? Buffer.alloc(0);
  const info = imageInfo(bytes);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!info) errors.push("That link isn't a JPEG, PNG, GIF or WebP image.");
  else if (!rule.types.includes(info.mime)) errors.push(`${platform === "instagram" ? "Instagram" : "This platform"} needs ${rule.types.map((t) => t.replace("image/", "").toUpperCase()).join(" or ")}; this image is ${info.mime.replace("image/", "").toUpperCase()}.`);
  if (res.truncated) errors.push(`The image is larger than ${Math.round(rule.maxBytes / 1048576)} MB.`);
  else if (rule.warnBytes && bytes.length > rule.warnBytes) warnings.push("The image is over 4 MB; smaller images upload more reliably.");
  if (info && (rule.minRatio || rule.maxRatio)) {
    const ratio = info.width / info.height;
    if ((rule.minRatio && ratio < rule.minRatio - 0.005) || (rule.maxRatio && ratio > rule.maxRatio + 0.005)) errors.push(`The image is ${info.width}×${info.height}; Instagram needs a shape between 4:5 (portrait) and 1.91:1 (landscape).`);
  }
  if (info && rule.minWidth && info.width < rule.minWidth) warnings.push(`The image is only ${info.width}px wide; Instagram will upscale it.`);
  return { url, ok: errors.length === 0, mime: info?.mime ?? null, width: info?.width ?? null, height: info?.height ?? null, bytes: res.truncated ? null : bytes.length, errors, warnings, checked_at: now.toISOString() };
}
