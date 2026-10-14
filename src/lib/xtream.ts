import { ProviderError, UNCATEGORISED, type Channel, type Details, type Season, type Series } from "./model";

/**
 * Parsing for the Xtream Codes `player_api.php` API. Panels are inconsistent about numbers versus
 * strings and nulls, so every field is read leniently.
 */

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** A JSON string or number as trimmed text; anything else is undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

// ---- URLs ----

/** Accepts `host:port`, `http://host:port/` and so on; defaults to HTTPS when no scheme is given. */
export function serverUrl(input: string): URL {
  const trimmed = input.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    throw new ProviderError("That server address doesn't look right.");
  }
}

export function apiUrl(server: URL, username: string, password: string, action?: string, extra: Record<string, string> = {}): string {
  const url = new URL("player_api.php", server);
  const params: [string, string][] = [["username", username], ["password", password]];
  if (action) params.push(["action", action]);
  params.push(...Object.entries(extra));
  // URLSearchParams writes spaces as "+", which some panels misread; encode them as %20.
  url.search = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return url.toString();
}

/** `{server}/{kind}/{user}/{pass}/{id}.{ext}`, the standard Xtream stream path. */
export function streamUrl(server: URL, kind: string, username: string, password: string, id: string, ext: string): string {
  return new URL([kind, username, password, `${id}.${ext}`].map(encodeURIComponent).join("/"), server).toString();
}

// ---- Account ----

export interface Account {
  authenticated: boolean;
  status?: string;
  outputFormats: string[];
}

export function account(root: Json): Account {
  const info = isObj(root) && isObj(root.user_info) ? root.user_info : undefined;
  if (!info) return { authenticated: false, outputFormats: [] };
  return {
    authenticated: str(info.auth) === "1",
    status: str(info.status),
    outputFormats: Array.isArray(info.allowed_output_formats) ? info.allowed_output_formats.map(str).filter((s): s is string => !!s) : [],
  };
}

/** HLS plays everywhere (hls.js, or natively on a Mac), so prefer it when the panel allows it. */
export function preferredFormat(allowed: string[]): string {
  return allowed.length === 0 || allowed.includes("m3u8") ? "m3u8" : "ts";
}

// ---- Catalogues ----

/** Some panels answer an empty catalogue with `{}` or an error object instead of `[]`. */
function list(root: Json): Obj[] {
  if (!Array.isArray(root)) throw new ProviderError("The provider sent a list in an unexpected format.");
  return root.filter(isObj);
}

/** Category id to name, in the provider's order. */
export function categories(root: Json): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of list(root)) {
    const id = str(c.category_id);
    if (id) result.set(id, str(c.category_name) ?? UNCATEGORISED);
  }
  return result;
}

const group = (cats: Map<string, string>, id: unknown) => cats.get(str(id) ?? "") ?? UNCATEGORISED;

export function liveChannels(server: URL, u: string, p: string, format: string, cats: Map<string, string>, root: Json): Channel[] {
  return list(root).flatMap((s) => {
    const id = str(s.stream_id);
    if (!id) return [];
    return [{
      id,
      name: str(s.name) ?? `Channel ${id}`,
      group: group(cats, s.category_id),
      logo: str(s.stream_icon),
      url: streamUrl(server, "live", u, p, id, format),
      epgId: str(s.epg_channel_id),
    }];
  });
}

export function films(server: URL, u: string, p: string, cats: Map<string, string>, root: Json): Channel[] {
  return list(root).flatMap((s) => {
    const id = str(s.stream_id);
    if (!id) return [];
    return [{
      id,
      name: str(s.name) ?? `Film ${id}`,
      group: group(cats, s.category_id),
      logo: str(s.stream_icon),
      url: streamUrl(server, "movie", u, p, id, str(s.container_extension) ?? "mp4"),
      added: Number(str(s.added)) || 0,
    }];
  });
}

export function series(cats: Map<string, string>, root: Json): Series[] {
  return list(root).flatMap((s) => {
    const id = str(s.series_id);
    if (!id) return [];
    return [{
      id,
      name: str(s.name) ?? `Series ${id}`,
      group: group(cats, s.category_id),
      cover: str(s.cover),
      plot: str(s.plot),
      added: Number(str(s.last_modified)) || 0,
    }];
  });
}

/**
 * Seasons from `get_series_info`. `episodes` is usually an object keyed by season number, but some
 * panels send a list of lists instead.
 */
export function seasons(server: URL, u: string, p: string, info: Json): Season[] {
  const episodes = isObj(info) ? info.episodes : undefined;
  const bySeason: [string | undefined, unknown][] = isObj(episodes)
    ? Object.entries(episodes)
    : Array.isArray(episodes) ? episodes.map((e) => [undefined, e]) : [];
  const result = bySeason.flatMap(([key, raw]) => {
    const parsed = Array.isArray(raw) ? raw.filter(isObj) : [];
    const seasonName = key ?? parsed.map((e) => str(e.season)).find(Boolean);
    if (!seasonName) return [];
    const eps: Channel[] = parsed.flatMap((e) => {
      const id = str(e.id);
      if (!id) return [];
      const num = str(e.episode_num);
      const title = str(e.title);
      const label = [num && `E${num}`, title && episodeTitle(title)].filter(Boolean).join("  ");
      const image = isObj(e.info) ? str(e.info.movie_image) : undefined;
      return [{
        id,
        name: label || `Episode ${id}`,
        group: `Season ${seasonName}`,
        logo: image,
        url: streamUrl(server, "series", u, p, id, str(e.container_extension) ?? "mp4"),
        plot: isObj(e.info) ? str(e.info.plot) : undefined,
        runtime: isObj(e.info) ? runtime(e.info) : undefined,
      }];
    });
    return eps.length ? [{ name: `Season ${seasonName}`, episodes: eps }] : [];
  });
  const n = (s: Season) => Number(s.name.slice(7)) || Number.MAX_SAFE_INTEGER;
  return result.sort((a, b) => n(a) - n(b));
}

const showAndCode = /^.*?\bS\d{1,2}\s*E\d{1,3}\b\s*[-–:|]?\s*/i;

/** "Ted Lasso - S04E10 - Being Alive" → "Being Alive"; titles without a code are kept as they are. */
export function episodeTitle(raw: string): string | undefined {
  const title = raw.trim();
  return title.replace(showAndCode, "").trim() || title || undefined;
}

/**
 * The `info` block of `get_vod_info` or `get_series_info`. Panels disagree on field names, numbers
 * versus strings and whether backdrops are a list, so each value is read leniently.
 */
export function details(root: Json): Details {
  const info = isObj(root) && isObj(root.info) ? root.info : undefined;
  if (!info) return {};
  const text = (...keys: string[]) => keys.map((k) => str(info[k])).find(Boolean);
  const b = info.backdrop_path;
  const backdrop = Array.isArray(b) ? b.map(str).find(Boolean) : str(b);
  let rating: string | undefined;
  const r = Number(text("rating", "rating_5based"));
  if (r > 0) {
    // rating_5based is out of five; scale it to ten like the rest.
    const ten = Number(str(info.rating)) > 0 ? r : r * 2;
    rating = ten.toFixed(1);
  }
  const out: Details = {
    plot: text("plot", "description"),
    genre: text("genre"),
    year: text("releasedate", "releaseDate", "release_date", "year")?.match(/\d{4}/)?.[0],
    rating,
    runtime: runtime(info),
    cast: text("cast", "actors"),
    backdrop: backdrop ?? text("cover_big", "movie_image"),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Details;
}

function runtime(info: Obj): string | undefined {
  const secs = Number(str(info.duration_secs));
  if (secs > 0) return minutesLabel(Math.floor(secs / 60));
  const d = str(info.duration)?.split(":").map((x) => Number(x.trim()));
  if (d?.length === 3 && d.every(Number.isFinite)) return minutesLabel(d[0] * 60 + d[1]);
  const ert = Number(str(info.episode_run_time));
  if (ert > 0) return `${ert} min`;
  return undefined;
}

function minutesLabel(minutes: number): string | undefined {
  if (minutes <= 0) return undefined;
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
