/**
 * A whole parcel (version 2): a section for each provider the device has, under its provider tag,
 * and the opt-in logins (telly-sync PROTOCOL.md). Reads version 1 parcels too, as one section for
 * the provider the reader says (its only one: with several it can't tell whose a version 1 parcel is).
 */
import type { Provider } from "../model";
import { syncIdentity } from "../model";
import { openLogins, providerTag, sealLogins, type Keys } from "./crypto";
import { isTime, merge, parseSection, sectionObject, trim, TOMBSTONE_MS, type Parcel } from "./parcel";

/** A provider's login as shared between devices that opt in, or its removal (no [provider]). */
export interface SharedLogin {
  at: number;
  provider?: Provider;
}

export interface Bundle {
  at: number;
  sections: Record<string, Parcel>;
  /** The opt-in logins, by provider tag; absent when this device doesn't share them (or the parcel has none). */
  logins?: Record<string, SharedLogin>;
}

export const MAX_SECTIONS = 20;
export const MAX_LOGINS = 20;

const TAG = /^[0-9a-f]{16}$/;
export const isTag = (t: string) => TAG.test(t);

function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const s = atob(text);
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The parcel; with [keys] and [device], any logins go in sealed. */
export function bundleJson(b: Bundle, keys?: Keys, device?: string): string {
  const providers = Object.fromEntries(
    Object.entries(b.sections)
      .sort((x, y) => y[1].at - x[1].at)
      .slice(0, MAX_SECTIONS)
      .map(([tag, section]) => [tag, sectionObject(trim(section, b.at))]),
  );
  const obj: Record<string, unknown> = { v: 2, at: b.at, providers };
  if (b.logins && keys && device) obj.logins = toBase64(sealLogins(keys, device, loginsText(trimLogins(b.logins, b.at))));
  return JSON.stringify(obj);
}

/**
 * Another device's parcel. [current] is the tag a version 1 parcel is read as (null: it's ignored).
 * With [keys] and the sending [device], its logins are opened too, each checked against its own tag.
 */
export function parseBundle(text: string, current: string | null, keys?: Keys, device?: string): Bundle | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const at = isTime(raw.at) ? raw.at : 0;
  if (raw.v === 1) return { at, sections: current ? { [current]: parseSection(raw, at) } : {} };
  if (raw.v !== 2) return null;
  const sections: Record<string, Parcel> = {};
  for (const [tag, value] of Object.entries(raw.providers ?? {})) {
    if (isTag(tag) && value && typeof value === "object" && Object.keys(sections).length < MAX_SECTIONS) sections[tag] = parseSection(value, at);
  }
  const b: Bundle = { at, sections };
  if (keys && device && typeof raw.logins === "string") {
    const box = fromBase64(raw.logins);
    const plain = box && openLogins(keys, device, box);
    if (plain) b.logins = parseLogins(plain, keys);
  }
  return b;
}

/** [own] combined with others, section by section, for the providers [own] has; and the logins, newest per tag, if [own] shares them. */
export function mergeBundles(own: Bundle, others: Bundle[], now: number): Bundle {
  const sections: Record<string, Parcel> = {};
  for (const [tag, section] of Object.entries(own.sections)) {
    sections[tag] = merge(section, others.flatMap((o) => (o.sections[tag] ? [o.sections[tag]] : [])), now);
  }
  const out: Bundle = { at: now, sections };
  if (own.logins) {
    const logins = { ...own.logins };
    for (const o of others) {
      for (const [tag, login] of Object.entries(o.logins ?? {})) if (!logins[tag] || logins[tag].at < login.at) logins[tag] = login;
    }
    out.logins = trimLogins(logins, now);
  }
  return out;
}

/** Drops removals past the tombstone time, and keeps the newest [MAX_LOGINS]. */
export function trimLogins(logins: Record<string, SharedLogin>, now: number): Record<string, SharedLogin> {
  return Object.fromEntries(
    Object.entries(logins)
      .filter(([, l]) => l.provider || now - l.at < TOMBSTONE_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_LOGINS),
  );
}

/** Written in the same JSON shape by every telly app. */
export function loginsText(logins: Record<string, SharedLogin>): string {
  const out: Record<string, unknown> = {};
  for (const [tag, { at, provider: p }] of Object.entries(logins)) {
    if (!p) out[tag] = { at, removed: true };
    else if (p.kind === "xtream") {
      out[tag] = { at, kind: "xtream", name: p.name, server: p.server, username: p.username, password: p.password, allowCleartext: p.allowCleartext };
    } else out[tag] = { at, kind: "m3u", name: p.name, url: p.url, allowCleartext: p.allowCleartext };
  }
  return JSON.stringify(out);
}

/** Logins another device shared, keeping only those whose tag matches their own identity. */
export function parseLogins(text: string, keys: Keys): Record<string, SharedLogin> {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, SharedLogin> = {};
  for (const [tag, o] of Object.entries<any>(raw ?? {})) {
    if (!isTag(tag) || !o || !isTime(o.at)) continue;
    if (o.removed === true) {
      out[tag] = { at: o.at };
      continue;
    }
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
    const allowCleartext = o.allowCleartext === true;
    let p: Provider;
    if (o.kind === "xtream") {
      const server = str("server"), username = str("username"), password = str("password");
      if (server === undefined || username === undefined || password === undefined) continue;
      p = { kind: "xtream", name: str("name") ?? "Your provider", server, username, password, allowCleartext };
    } else if (o.kind === "m3u") {
      const url = str("url");
      if (url === undefined) continue;
      p = { kind: "m3u", name: str("name") ?? "Your playlist", url, allowCleartext };
    } else continue;
    if (providerTag(keys, syncIdentity(p)) === tag) out[tag] = { at: o.at, provider: p };
  }
  return out;
}
