<script lang="ts">
  import Card from "../components/Card.svelte";
  import LazyRows from "../components/LazyRows.svelte";
  import Row from "../components/Row.svelte";
  import TopBar from "../components/TopBar.svelte";
  import type { Channel, Group, Series } from "../lib/model";
  import * as P from "../lib/playback";
  import { app } from "../lib/state.svelte";

  /** Films or Series: category chips, then a row per category (rendered as you scroll). */
  let { kind }: { kind: "films" | "series" } = $props();

  const groups = $derived((kind === "films" ? app.films : app.series) as Group<Channel | Series>[] | null);
  const total = $derived(groups?.reduce((n, g) => n + g.items.length, 0) ?? 0);
  const ROW = 24;

  // Series with an episode in progress, newest first.
  const watching = $derived(kind === "series"
    ? app.history.filter((h) => h.seriesId && !h.live).map((h) => app.seriesItem(h.seriesId!)).filter((s): s is Series => !!s)
    : []);

  const open = (item: Channel | Series) => kind === "films"
    ? app.go({ name: "filmDetail", film: item as Channel })
    : app.go({ name: "seriesDetail", series: item as Series });
  const image = (item: Channel | Series) => ("cover" in item ? item.cover : (item as Channel).logo);
</script>

<div class="screen">
  <TopBar placeholder={kind === "films" ? "Search films" : "Search series"} />
  <div class="page-head" data-tauri-drag-region><h2>{kind === "films" ? "Films" : "Series"}</h2>
    {#if groups}<span class="sub">{total.toLocaleString()} {kind} · {groups.length} categories</span>{/if}</div>
  {#if groups?.length}
    <div class="chips">
      {#each groups as g (g.name)}<button class="chip" onclick={() => app.go({ name: "grid", kind, group: g.name })}>{g.name}</button>{/each}
    </div>
    {#if watching.length}
      <Row title="Continue watching">
        {#each watching as s (s.id)}
          {@const h = app.seriesHistory(s.id)}
          {@const p = h ? app.progressOf(P.current(h).url) : undefined}
          <Card title={s.name} image={s.cover} progress={p ? P.fraction(p) : undefined} fav={{ kind: "series", id: s.id }} onclick={() => open(s)} />
        {/each}
      </Row>
    {/if}
    <LazyRows items={groups}>
      {#snippet row(g: Group<Channel | Series>)}
        <Row title={g.name} onSeeAll={g.items.length > ROW ? () => app.go({ name: "grid", kind, group: g.name }) : undefined}>
          {#each g.items.slice(0, ROW) as item (item.id)}
            <Card title={item.name} image={image(item)} fav={{ kind: kind === "films" ? "film" : "series", id: item.id }} onclick={() => open(item)} />
          {/each}
        </Row>
      {/snippet}
    </LazyRows>
  {:else if groups}
    <div class="empty"><b>Nothing here</b>Your provider doesn't list any {kind}.</div>
  {:else}
    <div class="empty"><b>Loading {kind}…</b>The first load can take a minute with a big provider.</div>
  {/if}
</div>
