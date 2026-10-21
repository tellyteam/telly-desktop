import { fetchTransport, type Transport } from "./sync/client";

/**
 * Everything outside the page, behind one small surface. On an LG TV (webOS) the TV itself
 * fetches and plays everything directly; under `npm run dev` in a browser it's the Vite dev
 * server's relay (browsers block providers' cross-origin answers) plus localStorage, so the UI
 * can be worked on without a TV.
 */

/** Built for LG TVs (`npm run build`). */
export const isWebOS = import.meta.env.VITE_TARGET === "webos";

let relayBase = "";
let cleartext = false;

export async function initBackend(): Promise<void> {
  relayBase = isWebOS ? "" : `${location.origin}/__relay/dev`;
}

/** Follows the active provider's "allow plain HTTP" setting. */
export function setAllowCleartext(allow: boolean) {
  cleartext = allow;
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The relay address for a provider URL. `hls` asks the relay to rewrite playlists (for playback). */
export function relayUrl(target: string, opts: { hls?: boolean } = {}): string {
  // The TV needs no relay: packaged webOS apps may fetch and play from any address.
  if (isWebOS) return target;
  const flags = (cleartext ? "c" : "") + (opts.hls ? "h" : "") || "-";
  let name = "x";
  try {
    name = new URL(target).pathname.split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || "x";
  } catch {
    /* keep "x" */
  }
  return `${relayBase}/${flags}/${b64url(target)}/${name}`;
}

/** Artwork goes through the relay too: providers serve it over plain HTTP from all sorts of hosts. */
export function img(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  if (url.startsWith("http:") && !cleartext) return undefined;
  return relayUrl(url);
}

/** Error messages name only the host, because Xtream URLs carry the login. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "The provider";
  }
}

export async function getText(url: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith("http:") && !cleartext) {
    throw new Error(`Unencrypted HTTP to ${host(url)} is turned off. If your provider has no HTTPS, allow it in Settings.`);
  }
  let res: Response;
  try {
    res = await fetch(relayUrl(url), { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`Couldn't reach ${host(url)}.`);
  }
  if (res.status === 502 || res.status === 403) throw new Error(await res.text());
  if (!res.ok) throw new Error(`${host(url)} returned HTTP ${res.status}.`);
  return res.text();
}

export async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const text = await getText(url, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The provider did not return valid JSON. Check the server address.");
  }
}

// ---- Storage: the TV's own, private to the app ----

export async function secretGet(name: string): Promise<string | null> {
  return localStorage.getItem(`telly.secret.${name}`);
}

export async function secretSet(name: string, value: string): Promise<void> {
  localStorage.setItem(`telly.secret.${name}`, value);
}

export async function secretDelete(name: string): Promise<void> {
  localStorage.removeItem(`telly.secret.${name}`);
}

export async function storeRead<T>(name: string): Promise<T | null> {
  try {
    const text = localStorage.getItem(`telly.store.${name}`);
    return text ? (JSON.parse(text) as T) : null;
  } catch (e) {
    console.warn(`Couldn't read ${name}`, e);
    return null;
  }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, () => void>();

/** Writes are coalesced (progress saves often), and flushed when the app closes. */
export function storeWrite(name: string, value: unknown, delayMs = 400): void {
  clearTimeout(pendingWrites.get(name));
  const write = () => {
    pendingWrites.delete(name);
    pendingValues.delete(name);
    localStorage.setItem(`telly.store.${name}`, JSON.stringify(value));
  };
  if (delayMs <= 0) return write();
  pendingValues.set(name, write);
  pendingWrites.set(name, setTimeout(write, delayMs));
}

export async function storeDelete(name: string): Promise<void> {
  localStorage.removeItem(`telly.store.${name}`);
}

/** Saves anything still waiting, e.g. just before the app closes. */
export function flushWrites(): void {
  for (const write of [...pendingValues.values()]) write();
}

// ---- Sync ----

export const syncTransport: Transport = fetchTransport;

// ---- The rest ----

export async function openExternal(url: string): Promise<void> {
  window.open(url, "_blank", "noopener");
}

export async function setFullscreen(on: boolean): Promise<void> {
  if (isWebOS) return; // always full screen
  if (on) await document.documentElement.requestFullscreen?.();
  else if (document.fullscreenElement) await document.exitFullscreen();
}

export async function isFullscreen(): Promise<boolean> {
  // A TV is always full screen, so there's never a full screen to leave: Back closes the player.
  return !isWebOS && !!document.fullscreenElement;
}

export async function appVersion(): Promise<string> {
  return __APP_VERSION__;
}
