<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  /** Renders a long list of rows a few at a time as the page scrolls, so big catalogues stay fast. */
  let { items, row, step = 6 }: { items: T[]; row: Snippet<[T]>; step?: number } = $props();
  let shown = $state(6);
  let sentinel = $state<HTMLDivElement>();

  $effect(() => {
    void items;
    shown = step;
  });

  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) shown += step; }, { rootMargin: "800px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

{#each items.slice(0, shown) as item, i (i)}{@render row(item)}{/each}
{#if shown < items.length}<div bind:this={sentinel} style="height: 1px"></div>{/if}
