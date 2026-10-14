<script lang="ts">
  import Art from "../components/Art.svelte";
  import TopBar from "../components/TopBar.svelte";
  import { playEpisode } from "../lib/actions";
  import type { Series, SeriesData } from "../lib/model";
  import * as P from "../lib/playback";
  import * as repo from "../lib/repo";
  import { app } from "../lib/state.svelte";

  let { series }: { series: Series } = $props();
  let data = $state.raw<SeriesData | null>(null);
  let error = $state<string | null>(null);
  let seasonIndex = $state(0);

  const history = $derived(app.seriesHistory(series.id));
  // Where to resume: the episode in the history (or the next one after its credits).
  const resumeAt = $derived.by(() => {
    if (!history || !data) return undefined;
    const i = P.continueIndex(history, app.progressOf);
    const ep = history.items[i];
    for (const [s, season] of data.seasons.entries()) {
      const e = season.episodes.findIndex((x) => x.id === ep.id);
      if (e >= 0) return { season: s, episode: e };
    }
    return undefined;
  });

  $effect(() => {
    const p = app.provider!;
    let cancelled = false;
    data = null;
    error = null;
    // Saved copy first for an instant page, then the latest from the provider.
    repo.seriesData(p, series, "cache").then((d) => { if (!cancelled && d) { data = d; pickSeason(); } }).catch(() => {});
    repo.seriesData(p, series, "network")
      .then((d) => { if (!cancelled && d) { const first = !data; data = d; if (first) pickSeason(); } })
      .catch((e) => { if (!cancelled && !data) error = (e as Error).message; });
    return () => { cancelled = true; };
  });

  function pickSeason() {
    seasonIndex = resumeAt?.season ?? 0;
  }

  const season = $derived(data?.seasons[seasonIndex]);
  const fav = $derived(app.isFavourite("series", series.id));

  function play(seasonI: number, epI: number) {
    const s = data!.seasons[seasonI];
    playEpisode(series, s.episodes, epI);
  }
  const epNumber = (name: string) => name.match(/^E(\d+)/)?.[1];
  const epTitle = (name: string) => name.replace(/^E\d+\s*/, "") || name;
</script>

<div class="screen">
  <TopBar search={false}><button class="btn small" onclick={() => app.goBack() || app.go({ name: "series" })}>‹ Back</button></TopBar>
  <section class="detail-hero">
    <div class="art"><Art src={data?.details.backdrop ?? series.cover} title={series.name} /></div>
    <div class="copy">
      <div class="eyebrow">Series · {series.group}</div>
      <div class="title-xl">{series.name}</div>
      <div class="meta">
        {#if data?.details.year}<span>{data.details.year}</span>{/if}
        {#if data}<span>{data.seasons.length} season{data.seasons.length === 1 ? "" : "s"}</span>{/if}
        {#if data?.details.rating}<span>★ {data.details.rating}</span>{/if}
        {#if data?.details.genre}<span>{data.details.genre}</span>{/if}
        {#if data?.details.runtime}<span>{data.details.runtime}</span>{/if}
      </div>
      <div class="synopsis">{data?.details.plot ?? series.plot ?? ""}</div>
      {#if data?.details.cast}<div class="cast">With {data.details.cast}</div>{/if}
      <div class="btns">
        {#if data?.seasons.length}
          {#if resumeAt}
            {@const ep = data.seasons[resumeAt.season].episodes[resumeAt.episode]}
            <button class="btn primary" onclick={() => play(resumeAt.season, resumeAt.episode)}>
              ▶ {app.progressOf(ep.url) && P.resumePosition(app.progressOf(ep.url)) ? "Resume" : "Play"} {data.seasons[resumeAt.season].name.replace("Season ", "S")}:E{epNumber(ep.name) ?? resumeAt.episode + 1}
            </button>
          {:else}
            <button class="btn primary" onclick={() => play(0, 0)}>▶ Play from the start</button>
          {/if}
        {/if}
        <button class="btn" class:on={fav} onclick={() => app.toggleFavourite("series", series.id)}>{fav ? "✓ In My List" : "＋ My List"}</button>
      </div>
    </div>
  </section>

  {#if error}
    <div class="empty"><b>Couldn't load the episodes</b>{error}</div>
  {:else if !data}
    <div class="empty"><div class="spinner"></div></div>
  {:else}
    {#if data.seasons.length > 1}
      <div class="chips">
        {#each data.seasons as s, i (s.name)}<button class="chip" class:sel={i === seasonIndex} onclick={() => (seasonIndex = i)}>{s.name}</button>{/each}
      </div>
    {/if}
    <div class="eps">
      {#each season?.episodes ?? [] as ep, i (ep.id)}
        {@const p = app.progressOf(ep.url)}
        <button class="ep" class:current={resumeAt?.season === seasonIndex && resumeAt.episode === i} onclick={() => play(seasonIndex, i)}>
          <div class="n">{epNumber(ep.name) ?? i + 1}</div>
          <div class="thumb"><Art src={ep.logo} title={ep.name + series.name} />
            {#if p && !P.finished(p)}<div class="bar"><div class="progress"><i style:width="{P.fraction(p) * 100}%"></i></div></div>{/if}
            <div class="play"><b>▶</b></div></div>
          <div><h5>{epTitle(ep.name)}</h5>{#if ep.plot}<p>{ep.plot}</p>{/if}</div>
          <div class="dur">
            {#if p && P.finished(p)}<span class="done">✓ Watched</span>
            {:else if p && P.resumePosition(p)}{Math.max(1, Math.round((p[1] - p[0]) / 60000))} min left
            {:else}{ep.runtime ?? ""}{/if}
          </div>
        </button>
      {:else}
        <div class="empty">No episodes listed for this season.</div>
      {/each}
    </div>
  {/if}
</div>
