/** Checking GitHub for a newer telly; reading the answer is kept separate so it's tested. */

export const RELEASES_API = "https://api.github.com/repos/tellyteam/telly-desktop/releases/latest";
export const RELEASES_PAGE = "https://github.com/tellyteam/telly-desktop/releases/latest";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Release {
  version: string;
  page: string;
  notes?: string;
}

export function parseRelease(root: unknown): Release | undefined {
  if (typeof root !== "object" || root === null) return undefined;
  const o = root as Record<string, unknown>;
  if (o.draft === true || o.prerelease === true) return undefined;
  const version = typeof o.tag_name === "string" ? o.tag_name.replace(/^v/, "").trim() : "";
  if (!version) return undefined;
  const page = typeof o.html_url === "string" && o.html_url.startsWith("https://github.com/") ? o.html_url : RELEASES_PAGE;
  const notes = typeof o.body === "string" ? cleanNotes(o.body) : undefined;
  return { version, page, notes };
}

/**
 * Release notes as shown in the app: never anyone's account name. Drops GitHub's generated
 * credits ("by @someone in …", "New Contributors", "Full Changelog") and any other @mention.
 */
export function cleanNotes(body: string): string | undefined {
  let skipping = false;
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^## New Contributors/i.test(line)) { skipping = true; continue; }
    if (line.startsWith("#")) { skipping = false; continue; }
    if (skipping || line.startsWith("**Full Changelog**") || line.includes("made their first contribution")) continue;
    lines.push(line.replace(/\s+by @[\w-]+(\s+in\s+\S+)?/g, "").replace(/@[\w-]+/g, "").replace(/ {2,}/g, " ").trimEnd());
  }
  return lines.join("\n").trim().replace(/\n{3,}/g, "\n\n") || undefined;
}

/** True when [candidate] (e.g. "1.2.0") is a higher version than [current] ("1.1.9"). */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((x) => Number(x) || 0);
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function latestRelease(): Promise<Release | undefined> {
  const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return undefined; // no releases yet
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  return parseRelease(await res.json());
}
