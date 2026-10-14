import { describe, expect, it } from "vitest";
import * as P from "./playback";
import { isNewer, parseRelease } from "./updates";

describe("progress", () => {
  it("key drops credentials from xtream urls", () => {
    expect(P.progressKey("https://tv.example:8080/series/me/secret/201.mkv")).toBe("series/201.mkv");
    expect(P.progressKey("https://tv.example/movie/me/secret/55.mp4")).toBe("movie/55.mp4");
  });

  it("the last minute counts as finished, and resume skips the very start and the end", () => {
    expect(P.finished([2_345_000, 2_400_000])).toBe(true);
    expect(P.finished([2_330_000, 2_400_000])).toBe(false);
    expect(P.resumePosition([10_000, 2_400_000])).toBe(0);
    expect(P.resumePosition([90_000, 2_400_000])).toBe(90_000);
    expect(P.resumePosition([2_390_000, 2_400_000])).toBe(0);
  });
});

describe("history", () => {
  const ep = (n: number) => ({ id: `${n}`, name: `E${n}`, group: "Season 1", url: `https://t/series/u/p/${n}.mkv` });
  const show = (index: number): P.LastWatched => ({ heading: "Show", live: false, index, items: [ep(1), ep(2)], seriesId: "9", at: 0 });

  it("keeps one slot per series, per film and for live", () => {
    const film: P.LastWatched = { heading: P.FILM, live: false, index: 0, items: [ep(5)], at: 0 };
    const h = P.remember(P.remember(P.remember([], show(0)), film), show(1));
    expect(h.map(P.slot)).toEqual(["series:9", "film:5"]);
    expect(h[0].index).toBe(1);
  });

  it("goes on to the next episode once the credits were reached", () => {
    expect(P.continueIndex(show(0), () => [2_390_000, 2_400_000])).toBe(1);
    expect(P.continueIndex(show(0), () => [600_000, 2_400_000])).toBe(0);
    expect(P.continueIndex(show(1), () => [2_390_000, 2_400_000])).toBe(1); // no next one
  });
});

describe("aspect", () => {
  const scale = (a: P.Aspect) => P.aspectScale(a, 1440, 1080, 1920, 1080); // 4:3 fitted on 16:9

  it("matches the TV app's scaling", () => {
    expect(scale({ kind: "original" })).toEqual([1, 1]);
    expect(scale({ kind: "stretch" })).toEqual([1920 / 1440, 1]);
    expect(scale({ kind: "16:9" })).toEqual([1920 / 1440, 1]);
    expect(scale({ kind: "zoom" })).toEqual([1920 / 1440, 1920 / 1440]);
    expect(P.aspectScale({ kind: "4:3" }, 1920, 1080, 1920, 1080)).toEqual([1440 / 1920, 1]);
    expect(P.aspectScale({ kind: "zoom" }, 0, 0, 1920, 1080)).toEqual([1, 1]);
  });

  it("round-trips through storage", () => {
    for (const { aspect } of P.ASPECTS) expect(P.decodeAspect(P.encodeAspect(aspect))).toEqual(aspect);
    expect(P.decodeAspect("custom:1.04:0.98")).toEqual({ kind: "custom", w: 1.04, h: 0.98 });
    expect(P.decodeAspect("junk")).toEqual({ kind: "original" });
  });
});

describe("engine", () => {
  it("picks a player by stream type", () => {
    expect(P.engineFor("https://t/live/u/p/1.m3u8", true)).toBe("hls");
    expect(P.engineFor("http://t/live/u/p/1.ts", true)).toBe("mpegts");
    expect(P.engineFor("http://t/12345", true)).toBe("mpegts");
    expect(P.engineFor("https://t/movie/u/p/5.mp4", false)).toBe("native");
    expect(P.engineFor("https://t/movie/u/p/5.mkv", false)).toBe("native");
  });

  it("formats clocks", () => {
    expect(P.clock(61_000)).toBe("1:01");
    expect(P.clock(3_723_000)).toBe("1:02:03");
  });
});

describe("updates", () => {
  it("reads a release and compares versions numerically", () => {
    expect(parseRelease({ tag_name: "v1.2.0", body: "Faster.", html_url: "https://github.com/tellyteam/telly-desktop/releases/tag/v1.2.0" }))
      .toEqual({ version: "1.2.0", page: "https://github.com/tellyteam/telly-desktop/releases/tag/v1.2.0", notes: "Faster." });
    expect(parseRelease({ tag_name: "v2", prerelease: true })).toBeUndefined();
    expect(parseRelease({ message: "Not Found" })).toBeUndefined();
    expect(parseRelease({ tag_name: "v1", html_url: "https://evil.example" })?.page).toMatch(/^https:\/\/github.com\/tellyteam/);
    expect(isNewer("1.10.0", "1.9.3")).toBe(true);
    expect(isNewer("v2.0", "1.99.99")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0-beta", "1.0.1")).toBe(false);
  });
});
