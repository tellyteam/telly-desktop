<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  /** A grid that adds cards as the page scrolls. */
  let { items, cell, kind = "" }: { items: T[]; cell: Snippet<[T]>; kind?: string } = $props();
  let shown = $state(120);
  let sentinel = $state<HTMLDivElement>();

  $effect(() => {
    void items;
    shown = 120;
  });

  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) shown += 120; }, { rootMargin: "1200px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

<div class="grid {kind}">{#each items.slice(0, shown) as item, i (i)}{@render cell(item)}{/each}</div>
{#if shown < items.length}<div bind:this={sentinel} style="height: 1px"></div>{/if}
