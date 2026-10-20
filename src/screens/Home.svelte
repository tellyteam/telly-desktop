<script lang="ts">
  import Art from "../components/Art.svelte";
  import Card from "../components/Card.svelte";
  import Row from "../components/Row.svelte";
  import TopBar from "../components/TopBar.svelte";
  import type { Channel, Series } from "../lib/model";
  import * as P from "../lib/playback";
  import { app } from "../lib/state.svelte";
  import { playChannel } from "../lib/actions";

  const pick = $derived(app.history[0]);
  const pickIndex = $derived(pick ? P.continueIndex(pick, app.progressOf) : 0);
  const pickItem = $derived(pick?.items[pickIndex]);
  const pickProgress = $derived(pickItem ? app.progressOf(pickItem.url) : undefined);
  const pickSeries = $derived(pick?.seriesId ? app.seriesItem(pick.seriesId) : undefined);
  const nextUp = $derived(!!pick && pickIndex !== pick.index);

  const favs = $derived(app.favouriteItems());
  const newFilms = $derived(app.recentlyAdded(app.films));
  const newSeries = $derived(app.recentlyAdded(app.series));

  function heroLabel(): string {
    if (!pick) return "";
    if (pick.live) return "Live TV";
    if (P.isFilm(pick)) return "Film";
    return nextUp ? "Up next" : pickItem?.group ?? "";
  }
  const openSeries = (s: Series) => app.go({ name: "seriesDetail", series: s });
  const openFilm = (f: Channel) => app.go({ name: "filmDetail", film: f });
  function badge(h: P.LastWatched) {
    if (h.live) return "Live";
    if (P.isFilm(h)) return "Film";
    const c = P.current(h);
    const s = c.group.replace(/^Season /, "S");
    const e = c.name.match(/^E(\d+)/)?.[1];
    return e ? `${s}:E${e}` : s;
  }
</script>

<div class="screen">
  <TopBar />
  {#if pick && pickItem}
    <section class="hero">
      <div class="art"><Art src={pickSeries?.cover ?? pick.art ?? pickItem.logo} title={pick.heading} /></div>
      <div class="copy">
        <div class="eyebrow">{nextUp ? "Up next" : "Pick up where you left off"}</div>
        <div class="title-xl">{pick.live ? pickItem.name : P.isFilm(pick) ? pickItem.name : pick.heading}</div>
        <div class="meta"><span>{heroLabel()}</span>{#if !pick.live && !P.isFilm(pick)}<span>{pickItem.name.replace(/^E\d+\s+/, "")}</span>{/if}</div>
        {#if pickSeries?.plot}<div class="synopsis">{pickSeries.plot}</div>{/if}
        {#if pickProgress && !pick.live && !P.finished(pickProgress)}
          <div style="width:300px;margin:12px 0 16px"><div class="progress"><i style:width="{P.fraction(pickProgress) * 100}%"></i></div>
            <div class="meta" style="margin-top:6px;font-size:12px">{Math.round(pickProgress[0] / 60000)} of {Math.round(pickProgress[1] / 60000)} min</div></div>
        {:else}<div style="height:16px"></div>{/if}
        <div class="btns">
          <button class="btn primary" onclick={() => app.resume(pick)}>▶ {pick.live ? "Watch" : nextUp ? "Play next episode" : pickProgress && P.resumePosition(pickProgress) ? "Resume" : "Play"}</button>
          {#if pickSeries}<button class="btn" onclick={() => openSeries(pickSeries)}>More info</button>{/if}
        </div>
      </div>
    </section>
  {:else}
    <div class="page-head" style="padding-top:8px"><h2>Welcome to telly</h2><span class="sub">Pick something from Live TV, Series or Films, and it'll show up here next time.</span></div>
  {/if}

  {#if app.history.length}
    <Row title="Continue watching">
      {#each app.history.slice(0, 20) as h (P.slot(h))}
        {@const item = h.items[P.continueIndex(h, app.progressOf)]}
        {@const p = app.progressOf(item.url)}
        <Card variant="landscape" title={h.live ? item.name : P.isFilm(h) ? item.name : h.heading} image={h.art ?? item.logo}
          badge={badge(h)} progress={!h.live && p ? P.fraction(p) : undefined} playable onclick={() => app.resume(h)}
          onremove={() => app.removeFromHistory(h)} />
      {/each}
    </Row>
  {/if}
  {#if favs.series.length || favs.films.length}
    <Row title="My List" onSeeAll={() => app.go({ name: "mylist" })}>
      {#each favs.series as s (s.id)}<Card title={s.name} image={s.cover} fav={{ kind: "series", id: s.id }} onclick={() => openSeries(s)} />{/each}
      {#each favs.films as f (f.id)}<Card title={f.name} image={f.logo} fav={{ kind: "film", id: f.id }} onclick={() => openFilm(f)} />{/each}
    </Row>
  {/if}
  {#if favs.live.length}
    <Row title="Favourite channels">
      {#each favs.live as c (c.id)}<Card variant="chan" title={c.name} image={c.logo} playable onclick={() => playChannel(c, favs.live)} />{/each}
    </Row>
  {/if}
  {#if newFilms.length}
    <Row title="Recently added films" onSeeAll={() => app.go({ name: "films" })}>
      {#each newFilms as f (f.id)}<Card title={f.name} image={f.logo} fav={{ kind: "film", id: f.id }} onclick={() => openFilm(f)} />{/each}
    </Row>
  {/if}
  {#if newSeries.length}
    <Row title="Recently updated series" onSeeAll={() => app.go({ name: "series" })}>
      {#each newSeries as s (s.id)}<Card title={s.name} image={s.cover} fav={{ kind: "series", id: s.id }} onclick={() => openSeries(s)} />{/each}
    </Row>
  {/if}
  {#if !app.live && app.refreshing}
    <div class="empty"><b>Loading your lists…</b>The first load can take a minute with a big provider. After that telly opens instantly.</div>
  {/if}
</div>
