/**
 * The keys and sealing for sync (telly-sync PROTOCOL.md). Pure JavaScript, so it runs
 * the same in WebKit, on LG TVs and in tests, without needing a secure context for WebCrypto.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SALT = "telly-sync v1";
const VERSION = 1;

const utf8 = (s: string) => new TextEncoder().encode(s);
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A new link code: 16 characters, 80 random bits. */
export function newCode(random = randomBytes): string {
  // 10 bytes = 80 bits = 16 groups of 5.
  const bytes = random(10);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Uppercase, no spaces or dashes, O→0, I/L→1; null unless it's 16 valid characters. */
export function normaliseCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return code.length === 16 && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** "ABCD-EFGH-JKMN-PQRS". */
export const formatCode = (code: string) => code.match(/.{1,4}/g)!.join("-");

export const newDeviceId = (random = randomBytes) => hex(random(8));

export interface Keys {
  mailbox: string;
  key: Uint8Array;
  auth: string;
  /** Keys provider tags (see [providerTag]). */
  provider: Uint8Array;
  /** Seals the opt-in logins box (see [sealLogins]). */
  logins: Uint8Array;
}

function base64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deriveKeys(code: string): Keys {
  const ikm = utf8(code);
  const derive = (info: string) => hkdf(sha256, ikm, utf8(SALT), utf8(info), 32);
  return {
    mailbox: hex(derive("mailbox").subarray(0, 16)),
    key: derive("key"),
    auth: base64url(derive("auth")),
    provider: derive("provider"),
    logins: derive("logins"),
  };
}

/** A provider's tag: meaningless without the link code; with it, only "same provider or not". */
export const providerTag = (keys: Keys, identity: string) => hex(hmac(sha256, keys.provider, utf8(identity)).subarray(0, 8));

const aad = (keys: Keys, device: string) => utf8(`${SALT}|${keys.mailbox}|${device}`);
const loginsAad = (keys: Keys, device: string) => utf8(`${SALT}|logins|${keys.mailbox}|${device}`);

export const seal = (keys: Keys, device: string, plaintext: string, nonce = randomBytes(12)) => sealBox(keys.key, aad(keys, device), plaintext, nonce);

/** The plaintext, or null if the parcel isn't ours, was altered, or is from a newer version. */
export const open = (keys: Keys, device: string, box: Uint8Array) => openBox(keys.key, aad(keys, device), box);

/** The opt-in logins box: sealed again, with its own key, inside the (already sealed) parcel. */
export const sealLogins = (keys: Keys, device: string, plaintext: string, nonce = randomBytes(12)) =>
  sealBox(keys.logins, loginsAad(keys, device), plaintext, nonce);

export const openLogins = (keys: Keys, device: string, box: Uint8Array) => openBox(keys.logins, loginsAad(keys, device), box);

function sealBox(key: Uint8Array, aad: Uint8Array, plaintext: string, nonce: Uint8Array): Uint8Array {
  const sealed = gcm(key, nonce, aad).encrypt(utf8(plaintext));
  const out = new Uint8Array(1 + 12 + sealed.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(sealed, 13);
  return out;
}

function openBox(key: Uint8Array, aad: Uint8Array, box: Uint8Array): string | null {
  if (box.length < 1 + 12 + 16 || box[0] !== VERSION) return null;
  try {
    const plain = gcm(key, box.subarray(1, 13), aad).decrypt(box.subarray(13));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
