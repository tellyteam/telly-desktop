/**
 * The address a QR code carries to link another device (telly-sync PROTOCOL.md):
 * `telly://sync?code=…`, plus `&relay=…` only for a relay other than telly's own.
 */
import { normaliseCode } from "./crypto";

export function syncLink(code: string, relay: string, defaultRelay: string): string {
  const base = `telly://sync?code=${code}`;
  return relay.replace(/\/+$/, "") === defaultRelay ? base : `${base}&relay=${encodeURIComponent(relay)}`;
}

/** The code and relay from a link, or null if it isn't one. */
export function parseSyncLink(text: string, defaultRelay: string): { code: string; relay: string } | null {
  const m = text.trim().match(/^telly:\/\/sync\?(.*)$/i);
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const code = normaliseCode(params.get("code") ?? "");
  const relay = params.get("relay") ?? defaultRelay;
  return code && relay.startsWith("https://") ? { code, relay } : null;
}
