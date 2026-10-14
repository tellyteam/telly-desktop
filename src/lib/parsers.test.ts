import { describe, expect, it } from "vitest";
import * as G from "./guide";
import { rewritePlaylist } from "./hls";
import { parseM3u } from "./m3u";
import { groupInOrder, UNCATEGORISED } from "./model";
import * as X from "./xtream";

const server = X.serverUrl("https://tv.example:8080");

describe("xtream", () => {
  it("server url defaults to https and tolerates a trailing slash", () => {
    expect(X.serverUrl("example.com:8080/").toString()).toBe("https://example.com:8080/");
    expect(X.serverUrl(" http://example.com ").toString()).toBe("http://example.com/");
    expect(() => X.serverUrl("ftp://x")).toThrow();
  });

  it("api url encodes credentials and extra parameters", () => {
    expect(X.apiUrl(X.serverUrl("https://example.com:8080/"), "me", "p&ss word", "get_series_info", { series_id: "9" }))
      .toBe("https://example.com:8080/player_api.php?username=me&password=p%26ss%20word&action=get_series_info&series_id=9");
  });

  it("account reads the auth flag and formats", () => {
    const ok = X.account({ user_info: { auth: 1, status: "Active", allowed_output_formats: ["m3u8", "ts"] } });
    expect(ok.authenticated).toBe(true);
    expect(X.preferredFormat(ok.outputFormats)).toBe("m3u8");
    expect(X.account({ user_info: { auth: 0 } }).authenticated).toBe(false);
    expect(X.account([]).authenticated).toBe(false);
    expect(X.preferredFormat(["ts"])).toBe("ts");
  });

  it("categories keep provider order and accept numeric ids", () => {
    const cats = X.categories([{ category_id: "7", category_name: "News" }, { category_id: 3, category_name: " Sport " }]);
    expect([...cats]).toEqual([["7", "News"], ["3", "Sport"]]);
  });

  it("live channels map categories and build stream urls", () => {
    const channels = X.liveChannels(server, "me", "secret", "m3u8", new Map([["7", "News"]]), [
      { name: "Channel A", stream_id: 101, stream_icon: "https://img/a.png", epg_channel_id: "a.uk", category_id: "7" },
      { name: "Channel B", stream_id: "102", stream_icon: "", epg_channel_id: null, category_id: null },
      { name: "No id" },
    ]);
    expect(channels).toHaveLength(2);
    const [a, b] = channels;
    expect(a.group).toBe("News");
    expect(a.url).toBe("https://tv.example:8080/live/me/secret/101.m3u8");
    expect(a.epgId).toBe("a.uk");
    expect(b.group).toBe(UNCATEGORISED);
    expect(b.logo).toBeUndefined();
    expect(b.epgId).toBeUndefined();
  });

  it("films use their container extension", () => {
    const [film] = X.films(server, "me", "secret", new Map([["1", "Action"]]),
      [{ stream_id: 55, name: "Film", category_id: "1", container_extension: "mkv", added: "1700000000" }]);
    expect(film.url).toBe("https://tv.example:8080/movie/me/secret/55.mkv");
    expect(film.group).toBe("Action");
    expect(film.added).toBe(1700000000);
  });

  it("series list reads cover and plot", () => {
    const [s] = X.series(new Map([["2", "Drama"]]), [{ series_id: 9, name: "Show", cover: "https://img/c.jpg", plot: "A plot.", category_id: "2" }]);
    expect(s).toMatchObject({ id: "9", group: "Drama", cover: "https://img/c.jpg", plot: "A plot." });
  });

  it("seasons parse object-keyed episodes in numeric order", () => {
    const seasons = X.seasons(server, "me", "secret", {
      episodes: {
        "10": [{ id: "1001", episode_num: 1, title: "Late", container_extension: "mp4", info: [] }],
        "2": [
          { id: "201", episode_num: 1, title: "Pilot", container_extension: "mkv", info: { movie_image: "https://img/e.jpg", plot: "It begins.", duration_secs: 2700 } },
          { id: "202", episode_num: "2", title: "Second", container_extension: "mkv" },
        ],
      },
    });
    expect(seasons.map((s) => s.name)).toEqual(["Season 2", "Season 10"]);
    const pilot = seasons[0].episodes[0];
    expect(pilot.name).toBe("E1  Pilot");
    expect(pilot.url).toBe("https://tv.example:8080/series/me/secret/201.mkv");
    expect(pilot.logo).toBe("https://img/e.jpg");
    expect(pilot.plot).toBe("It begins.");
    expect(pilot.runtime).toBe("45 min");
    expect(seasons[1].episodes).toHaveLength(1); // `info: []` must not drop the episode
  });

  it("seasons also accept a list of lists", () => {
    expect(X.seasons(server, "me", "secret", { episodes: [[{ id: "1", season: 1, episode_num: 1, title: "A" }]] })[0].name).toBe("Season 1");
  });

  it("details read film and series info leniently", () => {
    expect(X.details({ info: { plot: " A heist. ", genre: "Thriller", releasedate: "2024-03-01", rating: "7.43", duration: "01:52:00", backdrop_path: ["https://img/b.jpg"] } }))
      .toEqual({ plot: "A heist.", genre: "Thriller", year: "2024", rating: "7.4", runtime: "1h 52m", backdrop: "https://img/b.jpg" });
    const series = X.details({ info: { releaseDate: "2020", rating_5based: 4.1, episode_run_time: "45", backdrop_path: [], cover_big: "https://img/c.jpg" } });
    expect(series.rating).toBe("8.2");
    expect(series.runtime).toBe("45 min");
    expect(series.backdrop).toBe("https://img/c.jpg");
    expect(X.details([])).toEqual({});
  });

  it("episode titles drop the repeated show name and code", () => {
    expect(X.episodeTitle("Ted Lasso - S04E10 - Being Alive")).toBe("Being Alive");
    expect(X.episodeTitle("Show: S1 E1 | Pilot")).toBe("Pilot");
    expect(X.episodeTitle("The Letters")).toBe("The Letters");
    expect(X.episodeTitle("Show - S02E03")).toBe("Show - S02E03");
  });

  it("an object instead of a list is a clear error", () => {
    expect(() => X.films(server, "me", "secret", new Map(), { user_info: { auth: 0 } })).toThrow(/unexpected format/);
  });
});

describe("m3u", () => {
  it("reads attributes, title and url", () => {
    const [c] = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="https://img/bbc1.png" group-title="UK",BBC One HD\nhttps://cdn.example/bbc1.m3u8');
    expect(c).toEqual({ id: "https://cdn.example/bbc1.m3u8", name: "BBC One HD", group: "UK", logo: "https://img/bbc1.png", url: "https://cdn.example/bbc1.m3u8", epgId: "bbc1.uk" });
  });

  it("commas inside attribute values do not split the title", () => {
    const [c] = parseM3u('#EXTINF:-1 tvg-name="News, Live" group-title="News, World",Sky News\nhttp://x/1.ts');
    expect(c.name).toBe("Sky News");
    expect(c.group).toBe("News, World");
  });

  it("falls back to EXTGRP, then uncategorised", () => {
    expect(parseM3u("#EXTINF:-1,One\n#EXTGRP:Sport\nhttp://x/1.ts\n#EXTINF:-1,Two\nhttp://x/2.ts").map((c) => c.group)).toEqual(["Sport", UNCATEGORISED]);
  });

  it("bare urls and blank lines are tolerated", () => {
    const [c, ...rest] = parseM3u("\n#EXTM3U\n\nhttp://x/plain.ts\r\n#EXTVLCOPT:http-user-agent=foo\n");
    expect(rest).toEqual([]);
    expect(c.name).toBe("http://x/plain.ts");
    expect(c.logo).toBeUndefined();
  });
});

describe("guide", () => {
  it("short epg listings decode base64 and sort by start", () => {
    const list = G.programmes({ epg_listings: [
      { title: "RXZlbmluZyBOZXdz", description: "VGhlIGxhdGVzdCBoZWFkbGluZXMu", start_timestamp: "1800", stop_timestamp: "3600" },
      { title: "Breakfast", description: "", start_timestamp: "0", stop_timestamp: "1800" },
      { title: "", start_timestamp: "3600", stop_timestamp: "5400" },
    ] });
    expect(list.map((p) => p.title)).toEqual(["Breakfast", "Evening News"]);
    expect(list[1].description).toBe("The latest headlines.");
    expect(list[0].description).toBeUndefined();
    expect(list[1].start).toBe(1_800_000);
  });

  it("now and next pick the airing programme", () => {
    const a = { title: "A", start: 0, end: 1000 }, b = { title: "B", start: 1000, end: 2000 };
    expect(G.nowNext([a, b], 500)).toEqual({ now: a, next: b });
    expect(G.nowNext([a, b], 1500)).toEqual({ now: b, next: undefined });
    expect(G.nowNext([a, b], -10)).toEqual({ next: a });
    expect(G.progress(b, 1500)).toBe(0.5);
  });

  it("plain text titles are left alone", () => {
    expect(G.maybeBase64("News")).toBe("News");
    expect(G.maybeBase64("Match of the Day")).toBe("Match of the Day");
    expect(G.maybeBase64("SGVsbG8=")).toBe("Hello");
  });
});

describe("hls rewrite (matches the Rust relay)", () => {
  it("rewrites segments, variants and keys", () => {
    const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\n#EXTINF:6.0,\nseg1.ts\n\n#EXTINF:6.0,\n/root/seg2.ts\nhttps://other.example/seg3.ts\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/en.m3u8",NAME="English"\n';
    expect(rewritePlaylist(text, "http://cdn.example/hls/abc/index.m3u8", (u) => `R[${u}]`)).toBe(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="R[http://cdn.example/hls/abc/key.bin]",IV=0x1\n#EXTINF:6.0,\nR[http://cdn.example/hls/abc/seg1.ts]\n\n#EXTINF:6.0,\nR[http://cdn.example/root/seg2.ts]\nR[https://other.example/seg3.ts]\n#EXT-X-MEDIA:TYPE=AUDIO,URI="R[http://cdn.example/hls/abc/audio/en.m3u8]",NAME="English"\n',
    );
  });
});

describe("groupInOrder", () => {
  it("uses the provider's order, then unlisted groups", () => {
    const groups = groupInOrder([{ g: "b" }, { g: "x" }, { g: "a" }, { g: "b" }], ["a", "b", "missing"], (i) => i.g);
    expect(groups.map((g) => [g.name, g.items.length])).toEqual([["a", 1], ["b", 2], ["x", 1]]);
  });
});
