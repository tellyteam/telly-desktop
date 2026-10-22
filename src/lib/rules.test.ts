import { describe, expect, it } from "vitest";
import cases from "./playback-cases.json";
import * as P from "./playback";

/** telly-sync's playback-cases.json (copied beside this file): every app runs the same cases. */
describe("PLAYBACK.md", () => {
  it.each(cases.prompt)("prompt: $name", (c) => {
    expect(P.promptSeconds(c.durationMs, c.positionMs, c.hasNext, c.autoNext, c.dismissed, c.live)).toBe(c.seconds);
  });
  it.each(cases.atEnd)("at the end: $name", (c) => {
    expect(P.advanceAtEnd(c.hasNext, c.autoNext, c.dismissed)).toBe(c.advance);
  });
  it.each(cases.watched)("watched: $name", (c) => {
    expect(P.watched(c.positionMs, c.durationMs)).toBe(c.watched);
  });
  it.each(cases.resume)("resume: $name", (c) => {
    expect(P.startAt(c.positionMs, c.durationMs)).toBe(c.startAt);
  });
  it.each(cases.continue)("continue watching: $name", (c) => {
    const watched = (i: number) => c.watched.includes(i);
    expect(P.continueAt(c.index, c.items, watched)).toBe(c.continueIndex);
    expect(P.shownInContinue(c.index, c.items, watched)).toBe(c.shown);
  });
  it.each(cases.nextPlayable)("next playable: $name", (c) => {
    expect(P.nextPlayable(c.index, c.items, (i) => c.downloaded.includes(i), c.online)).toBe(c.next);
  });
});
