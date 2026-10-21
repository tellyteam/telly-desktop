/** Talking to the relay. Only sealed parcels ever leave the device. */
import { open, seal, type Keys } from "./crypto";
import { merge, parse, trim, type Parcel } from "./parcel";

export interface RelayRequest {
  method: "GET" | "PUT" | "DELETE";
  url: string;
  auth: string;
  body?: Uint8Array;
}

export interface RelayResponse {
  status: number;
  /** JSON responses only. */
  text: string;
}

/** How requests are sent (fetch everywhere; tests use their own). */
export type Transport = (r: RelayRequest) => Promise<RelayResponse>;

export const fetchTransport: Transport = async (r) => {
  const res = await fetch(r.url, {
    method: r.method,
    headers: { Authorization: `Bearer ${r.auth}`, ...(r.body ? { "Content-Type": "application/octet-stream" } : {}) },
    body: r.body as BodyInit | undefined,
    cache: "no-store",
  });
  return { status: res.status, text: await res.text() };
};

export class SyncError extends Error {}

function check(res: RelayResponse) {
  if (res.status === 401) throw new SyncError("This sync code is no longer valid on the relay.");
  if (res.status === 409) throw new SyncError("Too many devices are linked to this code (12 at most).");
  if (res.status < 200 || res.status >= 300) throw new SyncError(`The sync relay answered ${res.status}.`);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const base = (relay: string) => relay.replace(/\/+$/, "");

/** Every other device's parcel that opens with our key; anything else is ignored. */
export async function pull(transport: Transport, relay: string, keys: Keys, device: string): Promise<Parcel[]> {
  const res = await transport({ method: "GET", url: `${base(relay)}/v1/${keys.mailbox}`, auth: keys.auth });
  check(res);
  const { parcels } = JSON.parse(res.text) as { parcels: { device: string; body: string }[] };
  const result: Parcel[] = [];
  for (const p of parcels ?? []) {
    if (p.device === device) continue;
    const text = open(keys, p.device, fromBase64(p.body));
    const parcel = text === null ? null : parse(text);
    if (parcel) result.push(parcel);
  }
  return result;
}

export async function push(transport: Transport, relay: string, keys: Keys, device: string, parcel: Parcel): Promise<void> {
  const body = seal(keys, device, JSON.stringify(trim(parcel, parcel.at)));
  check(await transport({ method: "PUT", url: `${base(relay)}/v1/${keys.mailbox}/${device}`, auth: keys.auth, body }));
}

/** Takes this device's parcel off the relay (the others keep theirs). */
export async function leave(transport: Transport, relay: string, keys: Keys, device: string): Promise<void> {
  check(await transport({ method: "DELETE", url: `${base(relay)}/v1/${keys.mailbox}/${device}`, auth: keys.auth }));
}

/** One round: fetch the others, combine with [own], share the result. Returns the combined state. */
export async function syncOnce(transport: Transport, relay: string, keys: Keys, device: string, own: Parcel, now = Date.now()): Promise<Parcel> {
  const others = await pull(transport, relay, keys, device);
  const merged = merge(own, others, now);
  await push(transport, relay, keys, device, merged);
  return merged;
}
