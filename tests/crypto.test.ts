import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, isEncryptionKeyValid } from "../src/lib/social/crypto";

const key = randomBytes(32).toString("base64");
// Same pattern as the check constraint on social_account_credentials.
const DB_FORMAT = /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

test("round trip", () => {
  const sealed = encryptSecret("EAAB-secret-token", key);
  assert.equal(decryptSecret(sealed, key), "EAAB-secret-token");
});

test("ciphertext never contains the token and matches the database format", () => {
  const sealed = encryptSecret("EAAB-secret-token", key);
  assert.ok(!sealed.includes("EAAB"));
  assert.match(sealed, DB_FORMAT);
});

test("same input encrypts differently each time", () => {
  assert.notEqual(encryptSecret("x", key), encryptSecret("x", key));
});

test("tampering is detected", () => {
  const [v, iv, tag, data] = encryptSecret("token", key).split(":");
  const flipped = Buffer.from(data, "base64");
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join(":"), key));
});

test("wrong key fails", () => {
  const sealed = encryptSecret("token", key);
  assert.throws(() => decryptSecret(sealed, randomBytes(32).toString("base64")));
});

test("key must be 32 bytes", () => {
  assert.equal(isEncryptionKeyValid(undefined), false);
  assert.equal(isEncryptionKeyValid(randomBytes(16).toString("base64")), false);
  assert.equal(isEncryptionKeyValid(key), true);
  assert.throws(() => encryptSecret("x", "short"));
});
