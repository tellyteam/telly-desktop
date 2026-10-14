import { UNCATEGORISED, type Channel } from "./model";

/** Parses extended M3U playlists (`#EXTINF` with tvg-* and group-title attributes). */

const attribute = /([A-Za-z0-9_-]+)="([^"]*)"/g;

interface Info {
  name: string;
  attrs: Record<string, string>;
  extGroup?: string;
}

export function parseM3u(text: string): Channel[] {
  const channels: Channel[] = [];
  let pending: Info | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.slice(0, 8).toUpperCase();
    if (upper.startsWith("#EXTINF")) pending = parseInfo(line);
    else if (upper.startsWith("#EXTGRP:")) { if (pending) pending.extGroup = line.slice(8).trim(); }
    else if (line.startsWith("#")) continue;
    else {
      channels.push(toChannel(pending, line));
      pending = undefined;
    }
  }
  return channels;
}

function parseInfo(line: string): Info {
  const attrs: Record<string, string> = {};
  for (const m of line.matchAll(attribute)) attrs[m[1].toLowerCase()] = m[2];
  // Attribute values may contain commas, so drop them before looking for the title separator.
  const stripped = line.replace(attribute, "");
  const comma = stripped.indexOf(",");
  return { name: comma >= 0 ? stripped.slice(comma + 1).trim() : "", attrs };
}

function toChannel(info: Info | undefined, url: string): Channel {
  const a = info?.attrs ?? {};
  return {
    id: url,
    name: info?.name || a["tvg-name"] || url,
    group: a["group-title"] || info?.extGroup || UNCATEGORISED,
    logo: a["tvg-logo"] || undefined,
    url,
    epgId: a["tvg-id"] || undefined,
  };
}
