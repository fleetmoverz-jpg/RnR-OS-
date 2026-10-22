// AES-256-GCM encryption for social tokens. Output: "v1:<iv>:<tag>:<ciphertext>", all base64.
// The database rejects anything that doesn't have this shape, so plaintext can't be stored by mistake.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyBytes(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  return key;
}

export function encryptSecret(plain: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyBase64), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(sealed: string, keyBase64: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognised encrypted value.");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(keyBase64), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function isEncryptionKeyValid(keyBase64: string | undefined): boolean {
  if (!keyBase64) return false;
  try {
    keyBytes(keyBase64);
    return true;
  } catch {
    return false;
  }
}
