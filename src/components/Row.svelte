<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, onSeeAll, children }: { title: string; onSeeAll?: () => void; children: Snippet } = $props();
  let track: HTMLDivElement;
  const scroll = (dir: number) => track.scrollBy({ left: dir * track.clientWidth * 0.8, behavior: "smooth" });
</script>

<section class="row">
  <h3>{title}{#if onSeeAll}<button onclick={onSeeAll}>See all ›</button>{/if}</h3>
  <button class="arrow l" aria-label="Scroll left" tabindex="-1" onclick={() => scroll(-1)}>‹</button>
  <div class="track" bind:this={track}>{@render children()}</div>
  <button class="arrow r" aria-label="Scroll right" tabindex="-1" onclick={() => scroll(1)}>›</button>
</section>
