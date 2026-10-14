import type { Channel, Series } from "./model";
import { FILM } from "./playback";
import { app } from "./state.svelte";

/** Plays a live channel with its group as the playlist, so channel up/down moves through it. */
export function playChannel(c: Channel, group: Channel[]) {
  const items = group.length ? group : [c];
  app.play({ heading: "Live TV", live: true, items, index: Math.max(0, items.findIndex((x) => x.id === c.id)), aspectKey: `live:${c.id}` });
}

export function playFilm(f: Channel) {
  app.play({ heading: FILM, live: false, items: [f], index: 0, aspectKey: `film:${f.id}`, art: f.logo });
}

export function playEpisode(series: Series, episodes: Channel[], index: number, startAt?: number) {
  app.play({ heading: series.name, live: false, items: episodes, index, seriesId: series.id, art: series.cover, aspectKey: `series:${series.id}`, startAt });
}
