import { describe, expect, it } from "vitest";
import type { Channel } from "../model";
import * as P from "../playback";
import { apply, emptyLedger, toParcel, type Local } from "./local";
import type { Parcel } from "./parcel";

const ch = (id: string, kind = "series"): Channel => ({ id, name: `E${id}`, group: "Season 1", url: `http://host/${kind}/user/secret/${id}.mkv` });
const local = (l: Partial<Local>): Local => ({ progress: {}, history: [], favourites: [], ledger: emptyLedger(), ...l });
const parcel = (p: Partial<Parcel>): Parcel => ({ v: 1, at: 0, progress: {}, history: [], list: {}, cleared: 0, ...p });

describe("toParcel", () => {
  it("shares ids, positions and times, never URLs or names", () => {
    const p = toParcel(local({
      progress: { "series/1.mkv": [5, 10, 3], "http://host/u/p/1.ts": [1, 2, 3], "movie/9.mp4": [1, 2] },
      history: [
        { heading: "Ted", live: false, index: 0, items: [ch("1")], seriesId: "77", at: 9 },
        { heading: P.FILM, live: false, index: 0, items: [ch("9", "movie")], at: 8 },
        { heading: "Live TV", live: true, index: 0, items: [{ ...ch("http://m3u/stream", "live"), id: "http://m3u/stream" }], at: 7 },
      ],
      favourites: ["film:9", "live:http://m3u/x"],
    }), 100);
    expect(p.progress).toEqual({ "series/1.mkv": [5, 10, 3], "movie/9.mp4": [1, 2, 0] });
    expect(p.history).toEqual([{ kind: "series", id: "1", series: "77", at: 9 }, { kind: "film", id: "9", at: 8 }]);
    expect(p.list).toEqual({ "film:9": [0, true] });
    const text = JSON.stringify(p);
    for (const secret of ["user", "secret", "host", "Ted", "E1"]) expect(text).not.toContain(secret);
  });

  it("shares removals until the slot is watched again", () => {
    const removedOnly = toParcel(local({ ledger: { list: {}, removed: { "film:9": 50, "series:77": 50 }, cleared: 0 } }), 0);
    expect(removedOnly.history).toEqual([
      { kind: "film", id: "9", at: 50, removed: true },
      { kind: "series", id: "77", series: "77", at: 50, removed: true },
    ]);
    const watchedAgain = toParcel(local({
      history: [{ heading: P.FILM, live: false, index: 0, items: [ch("9", "movie")], at: 60 }],
      ledger: { list: {}, removed: { "film:9": 50 }, cleared: 0 },
    }), 0);
    expect(watchedAgain.history).toEqual([{ kind: "film", id: "9", at: 60 }]);
  });
});

describe("apply", () => {
  const resolveFilm = async (e: { kind: string; id: string; at: number }) =>
    e.kind === "film" ? { heading: P.FILM, live: false, index: 0, items: [ch(e.id, "movie")], at: 0 } : null;

  it("takes newer progress and keeps its own newer progress", async () => {
    const next = await apply(
      local({ progress: { "series/1.mkv": [5, 10, 20], "series/2.mkv": [1, 10, 1] } }),
      parcel({ progress: { "series/1.mkv": [9, 10, 10], "series/2.mkv": [8, 10, 5] } }),
      resolveFilm,
    );
    expect(next.progress).toEqual({ "series/1.mkv": [5, 10, 20], "series/2.mkv": [8, 10, 5] });
  });

  it("adds and removes My List items by time, newest first", async () => {
    const next = await apply(
      local({ favourites: ["film:1", "film:2"], ledger: { list: { "film:2": [10, true] }, removed: {}, cleared: 0 } }),
      parcel({ list: { "film:1": [5, false], "film:2": [5, false], "film:3": [30, true] } }),
      resolveFilm,
    );
    expect(next.favourites).toEqual(["film:3", "film:2"]);
    expect(next.ledger.list["film:1"]).toEqual([5, false]);
  });

  it("brings in history it can play here, newest first, and drops removed entries", async () => {
    const next = await apply(
      local({ history: [
        { heading: P.FILM, live: false, index: 0, items: [ch("5", "movie")], at: 10 },
        { heading: P.FILM, live: false, index: 0, items: [ch("6", "movie")], at: 40 },
      ] }),
      parcel({ history: [
        { kind: "film", id: "7", at: 30 },
        { kind: "film", id: "5", at: 20, removed: true },
        { kind: "film", id: "6", at: 35, removed: true }, // older than watching it here
        { kind: "series", id: "1", series: "2", at: 50 }, // not resolvable here
      ] }),
      resolveFilm,
    );
    expect(next.history.map((h) => [P.current(h).id, h.at])).toEqual([["6", 40], ["7", 30]]);
    expect(next.ledger.removed).toEqual({ "film:5": 20 });
  });

  it("ignores an entry already removed here more recently", async () => {
    const next = await apply(local({ ledger: { list: {}, removed: { "film:7": 99 }, cleared: 0 } }), parcel({ history: [{ kind: "film", id: "7", at: 30 }] }), resolveFilm);
    expect(next.history).toEqual([]);
  });
});

describe("clearing progress", () => {
  it("drops older progress and history everywhere, but keeps My List and anything newer", async () => {
    const next = await apply(
      local({
        progress: { "series/1.mkv": [5, 10, 20], "series/2.mkv": [5, 10] },
        history: [{ heading: P.FILM, live: false, index: 0, items: [ch("5", "movie")], at: 10 }],
        favourites: ["film:5"],
      }),
      parcel({ cleared: 30, progress: { "series/3.mkv": [1, 10, 40] } }),
      async () => null,
    );
    expect(next.progress).toEqual({ "series/3.mkv": [1, 10, 40] });
    expect(next.history).toEqual([]);
    expect(next.favourites).toEqual(["film:5"]);
    expect(next.ledger.cleared).toBe(30);
  });

  it("travels in the parcel, so other devices clear too", () => {
    const p = toParcel(local({ progress: { "series/1.mkv": [5, 10, 20] }, ledger: { ...emptyLedger(), cleared: 30 } }), 50);
    expect(p.cleared).toBe(30);
    expect(p.progress).toEqual({});
  });
});
