import { invoke } from "@tauri-apps/api/core";

/**
 * Everything native, behind one small surface. In the app it's the Rust core; under `npm run dev`
 * in a plain browser it's the Vite dev server's relay plus localStorage, so the UI can be worked on
 * without building the app.
 */

export const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
/** Safari's engine (the app's web view on a Mac), as opposed to Chromium (Windows, or a dev browser). */
export const isWebKit = typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

let relayBase = "";
let cleartext = false;

export async function initBackend(): Promise<void> {
  relayBase = inApp ? await invoke<string>("relay_base") : `${location.origin}/__relay/dev`;
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

// ---- Private storage: the login in the Keychain / Credential Manager, the rest encrypted on disk ----

export async function secretGet(name: string): Promise<string | null> {
  if (inApp) return (await invoke<string | null>("secret_get", { name })) ?? null;
  return localStorage.getItem(`telly.secret.${name}`);
}

export async function secretSet(name: string, value: string): Promise<void> {
  if (inApp) return invoke("secret_set", { name, value });
  localStorage.setItem(`telly.secret.${name}`, value);
}

export async function secretDelete(name: string): Promise<void> {
  if (inApp) return invoke("secret_delete", { name });
  localStorage.removeItem(`telly.secret.${name}`);
}

export async function storeRead<T>(name: string): Promise<T | null> {
  try {
    const text = inApp ? await invoke<string | null>("store_read", { name }) : localStorage.getItem(`telly.store.${name}`);
    return text ? (JSON.parse(text) as T) : null;
  } catch (e) {
    console.warn(`Couldn't read ${name}`, e);
    return null;
  }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, () => void>();

/** Writes are coalesced (progress saves often), and flushed when the window closes. */
export function storeWrite(name: string, value: unknown, delayMs = 400): void {
  clearTimeout(pendingWrites.get(name));
  const write = () => {
    pendingWrites.delete(name);
    pendingValues.delete(name);
    const text = JSON.stringify(value);
    if (inApp) invoke("store_write", { name, text }).catch((e) => console.warn(`Couldn't save ${name}`, e));
    else localStorage.setItem(`telly.store.${name}`, text);
  };
  if (delayMs <= 0) return write();
  pendingValues.set(name, write);
  pendingWrites.set(name, setTimeout(write, delayMs));
}

export async function storeDelete(name: string): Promise<void> {
  if (inApp) return invoke("store_delete", { name });
  localStorage.removeItem(`telly.store.${name}`);
}

// ---- Desktop bits ----

export async function vlcAvailable(): Promise<boolean> {
  return inApp ? invoke<boolean>("vlc_available") : false;
}

export async function openInVlc(url: string, title: string): Promise<void> {
  if (inApp) return invoke("open_in_vlc", { url, title });
  throw new Error("VLC is only available in the app.");
}

export async function openExternal(url: string): Promise<void> {
  if (inApp) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener");
}

export async function setFullscreen(on: boolean): Promise<void> {
  if (inApp) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().setFullscreen(on);
  }
  if (on) await document.documentElement.requestFullscreen?.();
  else if (document.fullscreenElement) await document.exitFullscreen();
}

export async function isFullscreen(): Promise<boolean> {
  if (inApp) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().isFullscreen();
  }
  return !!document.fullscreenElement;
}

export async function appVersion(): Promise<string> {
  if (inApp) {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  }
  return __APP_VERSION__;
}

/** Saves anything still waiting, e.g. just before the window closes. */
export function flushWrites(): void {
  for (const write of [...pendingValues.values()]) write();
}
