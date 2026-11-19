import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

export async function hashAdminPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Yönetici parolası en az 12 karakter olmalı.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, KEY_LENGTH);
  return "scrypt$" + salt + "$" + Buffer.from(key).toString("hex");
}

export async function verifyAdminPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [scheme, salt, expectedHex, extra] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex || extra ||
      !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expectedHex)) return false;
  const actual = Buffer.from(await scrypt(password, salt, KEY_LENGTH));
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createSessionToken(secret, ttlSeconds = 43200, nowMs = Date.now()) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("WINSCOPE_SESSION_SECRET en az 32 byte olmalı.");
  }
  const now = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + ttlSeconds })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + signature;
}

export function verifySessionToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== "string" || typeof secret !== "string" || Buffer.byteLength(secret) < 32) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, supplied] = parts;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(supplied, "base64url"); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(nowMs / 1000);
    return Number.isInteger(data.iat) && Number.isInteger(data.exp) &&
      data.iat <= now + 60 && data.exp > now && data.exp > data.iat &&
      data.exp - data.iat <= 43200;
  } catch { return false; }
}
