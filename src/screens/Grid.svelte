<script lang="ts">
  import Card from "../components/Card.svelte";
  import LazyGrid from "../components/LazyGrid.svelte";
  import TopBar from "../components/TopBar.svelte";
  import type { Channel, Series } from "../lib/model";
  import { app } from "../lib/state.svelte";

  /** "See all": one category as a grid that fills the window, with a quick filter and sorting. */
  let { kind, group }: { kind: "films" | "series"; group: string } = $props();

  let filter = $state("");
  let sort = $state<"provider" | "az" | "new">("provider");
  const all = $derived(((kind === "films" ? app.films : app.series) ?? []).find((g) => g.name === group)?.items ?? []) as (Channel | Series)[];
  const items = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    let list = q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all;
    if (sort === "az") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "new") list = [...list].sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
    return list;
  });
  const open = (item: Channel | Series) => kind === "films"
    ? app.go({ name: "filmDetail", film: item as Channel })
    : app.go({ name: "seriesDetail", series: item as Series });
</script>

<div class="screen">
  <TopBar search={false}>
    <button class="btn small" onclick={() => app.goBack() || app.go({ name: kind })}>‹ {kind === "films" ? "Films" : "Series"}</button>
    <label class="search-box"><span>⌕</span><input bind:value={filter} placeholder="Filter {group}" spellcheck="false" /></label>
  </TopBar>
  <div class="page-head"><h2>{group}</h2><span class="sub">{items.length.toLocaleString()} {kind}</span></div>
  <div class="chips">
    <button class="chip" class:sel={sort === "provider"} onclick={() => (sort = "provider")}>Provider order</button>
    <button class="chip" class:sel={sort === "az"} onclick={() => (sort = "az")}>A–Z</button>
    {#if all.some((i) => i.added)}<button class="chip" class:sel={sort === "new"} onclick={() => (sort = "new")}>Newest</button>{/if}
  </div>
  <LazyGrid {items}>
    {#snippet cell(item: Channel | Series)}
      <Card title={item.name} image={"cover" in item ? item.cover : (item as Channel).logo}
        fav={{ kind: kind === "films" ? "film" : "series", id: item.id }} onclick={() => open(item)} />
    {/snippet}
  </LazyGrid>
</div>
