/**
 * Saved catalogues: the provider's raw answers, kept in the web view's IndexedDB so telly opens
 * instantly and refreshes in the background. Scoped by a hash of server and username, so
 * switching providers never mixes lists. (The answers themselves contain no login.)
 */

const DB = "telly-cache";
const STORE = "responses";
let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function scope(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Saved {
  text: string;
  savedAt: number;
}

export async function read(scope: string, name: string): Promise<Saved | undefined> {
  try {
    return await tx<Saved | undefined>("readonly", (s) => s.get(`${scope}/${name}`));
  } catch {
    return undefined;
  }
}

export async function write(scope: string, name: string, text: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put({ text, savedAt: Date.now() } satisfies Saved, `${scope}/${name}`));
  } catch (e) {
    console.warn("Couldn't save a catalogue", e);
  }
}

export async function clearAll(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
}
