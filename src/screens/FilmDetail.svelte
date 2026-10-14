<script lang="ts">
  import Art from "../components/Art.svelte";
  import TopBar from "../components/TopBar.svelte";
  import { playFilm } from "../lib/actions";
  import type { Channel, Details } from "../lib/model";
  import * as P from "../lib/playback";
  import * as repo from "../lib/repo";
  import { app } from "../lib/state.svelte";

  let { film }: { film: Channel } = $props();
  let details = $state.raw<Details | null>(null);

  $effect(() => {
    const p = app.provider!;
    let cancelled = false;
    repo.filmDetails(p, film, "cache").then((d) => { if (!cancelled && d) details = d; }).catch(() => {});
    repo.filmDetails(p, film, "network").then((d) => { if (!cancelled && d) details = d; }).catch(() => {});
    return () => { cancelled = true; };
  });

  const progress = $derived(app.progressOf(film.url));
  const resumable = $derived(!!progress && P.resumePosition(progress) > 0);
  const fav = $derived(app.isFavourite("film", film.id));
</script>

<div class="screen">
  <TopBar search={false}><button class="btn small" onclick={() => app.goBack() || app.go({ name: "films" })}>‹ Back</button></TopBar>
  <section class="detail-hero">
    <div class="art"><Art src={details?.backdrop ?? film.logo} title={film.name} /></div>
    <div class="copy">
      <div class="eyebrow">Film · {film.group}</div>
      <div class="title-xl">{film.name}</div>
      <div class="meta">
        {#if details?.year}<span>{details.year}</span>{/if}
        {#if details?.runtime}<span>{details.runtime}</span>{/if}
        {#if details?.rating}<span>★ {details.rating}</span>{/if}
        {#if details?.genre}<span>{details.genre}</span>{/if}
      </div>
      {#if details?.plot}<div class="synopsis">{details.plot}</div>{:else}<div style="height:14px"></div>{/if}
      {#if details?.cast}<div class="cast">With {details.cast}</div>{/if}
      {#if resumable && progress}
        <div style="width:300px;margin:0 0 16px"><div class="progress"><i style:width="{P.fraction(progress) * 100}%"></i></div>
          <div class="meta" style="margin-top:6px;font-size:12px">{Math.round(progress[0] / 60000)} of {Math.round(progress[1] / 60000)} min</div></div>
      {/if}
      <div class="btns">
        <button class="btn primary" onclick={() => playFilm(film)}>▶ {resumable ? "Resume" : "Play"}</button>
        {#if resumable}<button class="btn" onclick={() => app.play({ heading: P.FILM, live: false, items: [film], index: 0, aspectKey: `film:${film.id}`, art: film.logo, startAt: 0 })}>Play from the start</button>{/if}
        <button class="btn" class:on={fav} onclick={() => app.toggleFavourite("film", film.id)}>{fav ? "✓ In My List" : "＋ My List"}</button>
      </div>
    </div>
  </section>
</div>
