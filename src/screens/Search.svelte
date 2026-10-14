<script lang="ts">
  import Card from "../components/Card.svelte";
  import Row from "../components/Row.svelte";
  import { playChannel } from "../lib/actions";
  import { isMac } from "../lib/backend";
  import { app } from "../lib/state.svelte";

  let query = $state("");
  let debounced = $state("");
  let input: HTMLInputElement;

  $effect(() => {
    const q = query;
    const t = setTimeout(() => (debounced = q), 120);
    return () => clearTimeout(t);
  });
  $effect(() => input.focus());

  const results = $derived(app.search(debounced));
  const none = $derived(debounced.trim() && !results.live.length && !results.films.length && !results.series.length);
</script>

<div class="screen">
  <div class="topbar drag" data-tauri-drag-region></div>
  <label class="big-input">⌕ <input bind:this={input} bind:value={query} placeholder="Search films, series and channels" spellcheck="false" autocomplete="off" />
    <kbd>Esc</kbd></label>
  {#if !debounced.trim()}
    <div class="empty">Type to search every film, series and channel. Tip: press <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd> or <kbd>/</kbd> from anywhere.</div>
  {:else if none}
    <div class="empty"><b>No matches for “{debounced.trim()}”</b>Try fewer letters, or check the spelling.</div>
  {/if}
  {#if results.series.length}
    <Row title="Series">{#each results.series as s (s.id)}<Card title={s.name} image={s.cover} fav={{ kind: "series", id: s.id }} onclick={() => app.go({ name: "seriesDetail", series: s })} />{/each}</Row>
  {/if}
  {#if results.films.length}
    <Row title="Films">{#each results.films as f (f.id)}<Card title={f.name} image={f.logo} fav={{ kind: "film", id: f.id }} onclick={() => app.go({ name: "filmDetail", film: f })} />{/each}</Row>
  {/if}
  {#if results.live.length}
    <Row title="Channels">{#each results.live as c (c.id)}<Card variant="chan" title={c.name} image={c.logo} playable fav={{ kind: "live", id: c.id }} onclick={() => playChannel(c, results.live)} />{/each}</Row>
  {/if}
</div>
