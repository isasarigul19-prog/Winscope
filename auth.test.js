import test from "node:test";
import assert from "node:assert/strict";
import { hashAdminPassword, verifyAdminPassword, createSessionToken, verifySessionToken } from "./auth.js";

const secret = "a".repeat(64);

test("parola özeti doğru parolayı doğrular, yanlışını reddeder", async () => {
  const hash = await hashAdminPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyAdminPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyAdminPassword("wrong password", hash), false);
});
test("zayıf parola reddedilir", async () => {
  await assert.rejects(() => hashAdminPassword("short"));
});
test("oturum süresi dolana kadar geçerlidir", () => {
  const now = 1_800_000_000_000;
  const token = createSessionToken(secret, 3600, now);
  assert.equal(verifySessionToken(token, secret, now + 1000), true);
});
test("süresi dolan, değiştirilmiş veya yanlış anahtarlı oturum reddedilir", () => {
  const now = 1_800_000_000_000;
  const token = createSessionToken(secret, 3600, now);
  assert.equal(verifySessionToken(token, secret, now + 3_600_000), false);
  assert.equal(verifySessionToken(token + "x", secret, now + 1000), false);
  assert.equal(verifySessionToken(token, "b".repeat(64), now + 1000), false);
});
test("kısa oturum anahtarı reddedilir", () => {
  assert.throws(() => createSessionToken("short"));
  assert.equal(verifySessionToken("x.y", "short"), false);
});
