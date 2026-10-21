<script lang="ts">
  import Card from "../components/Card.svelte";
  import TopBar from "../components/TopBar.svelte";
  import { playChannel } from "../lib/actions";
  import { app } from "../lib/state.svelte";

  let tab = $state<"all" | "series" | "films" | "live">("all");
  const favs = $derived(app.favouriteItems());
  const count = $derived(favs.series.length + favs.films.length + favs.live.length);
</script>

<div class="screen">
  <TopBar />
  <div class="page-head"><h2>My List</h2><span class="sub">Hover a title and click ♥ to add or remove it</span></div>
  <div class="chips">
    <button class="chip" class:sel={tab === "all"} onclick={() => (tab = "all")}>All</button>
    {#if app.provider?.kind === "xtream"}
      <button class="chip" class:sel={tab === "series"} onclick={() => (tab = "series")}>Series · {favs.series.length}</button>
      <button class="chip" class:sel={tab === "films"} onclick={() => (tab = "films")}>Films · {favs.films.length}</button>
    {/if}
    <button class="chip" class:sel={tab === "live"} onclick={() => (tab = "live")}>Channels · {favs.live.length}</button>
  </div>
  {#if !count}
    <div class="empty"><b>Nothing saved yet</b>Hover any film, series or channel and click ♥, or use “＋ My List” on its page.</div>
  {/if}
  {#if (tab === "all" || tab === "series") && favs.series.length + favs.films.length}
    <div class="grid">
      {#if tab === "all" || tab === "series"}
        {#each favs.series as s (s.id)}<Card title={s.name} image={s.cover} fav={{ kind: "series", id: s.id }} onclick={() => app.go({ name: "seriesDetail", series: s })} />{/each}
      {/if}
      {#if tab === "all"}
        {#each favs.films as f (f.id)}<Card title={f.name} image={f.logo} fav={{ kind: "film", id: f.id }} onclick={() => app.go({ name: "filmDetail", film: f })} />{/each}
      {/if}
    </div>
  {/if}
  {#if tab === "films"}
    <div class="grid">{#each favs.films as f (f.id)}<Card title={f.name} image={f.logo} fav={{ kind: "film", id: f.id }} onclick={() => app.go({ name: "filmDetail", film: f })} />{/each}</div>
  {/if}
  {#if (tab === "all" || tab === "live") && favs.live.length}
    {#if tab === "all"}<div class="results-label">Channels</div>{/if}
    <div class="grid chans">{#each favs.live as c (c.id)}<Card variant="chan" title={c.name} image={c.logo} playable fav={{ kind: "live", id: c.id }} onclick={() => playChannel(c, favs.live)} />{/each}</div>
  {/if}
</div>
