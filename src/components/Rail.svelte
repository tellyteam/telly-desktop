<script lang="ts">
  import { ago, app, type Route } from "../lib/state.svelte";
  import Wordmark from "./Wordmark.svelte";

  const mod = "⌘";
  const icons: Record<string, string> = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    search: '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2"/>',
    live: '<path d="M3 7h18v12H3zM8 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/>',
    series: '<path d="M3 6h18v11H3zM8 21h8" fill="none" stroke="currentColor" stroke-width="2"/>',
    films: '<path d="M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    mylist: '<path d="M12 4v16M4 12h16" stroke="currentColor" stroke-width="2.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2"/>',
    settings: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2"/>',
  };
  type Top = "home" | "search" | "live" | "series" | "films" | "mylist";
  const items: [Top, string, string][] = [
    ["home", "Home", `${mod}1`], ["search", "Search", `${mod}K`], ["live", "Live TV", `${mod}2`],
    ["series", "Series", `${mod}3`], ["films", "Films", `${mod}4`], ["mylist", "My List", `${mod}5`],
  ];
  const section = (r: Route) => (r.name === "seriesDetail" || (r.name === "grid" && r.kind === "series") ? "series"
    : r.name === "filmDetail" || r.name === "grid" ? "films" : r.name);
  const m3u = $derived(app.provider?.kind === "m3u");
</script>

<nav class="rail">
  <div class="wordmark"><Wordmark height={26} /></div>
  {#each items.filter(([id]) => !(m3u && (id === "series" || id === "films"))) as [id, label, k]}
    <button class="nav" class:current={section(app.route) === id} onclick={() => app.go({ name: id })} title={label}>
      <svg viewBox="0 0 24 24" fill="currentColor">{@html icons[id]}</svg><span>{label}</span><kbd class="k">{k}</kbd>
    </button>
  {/each}
  <div class="spacer"></div>
  <button class="nav refresh" class:spinning={app.refreshing} onclick={() => app.refresh()} disabled={app.refreshing} title="Refresh lists">
    <svg viewBox="0 0 24 24" fill="currentColor">{@html icons.refresh}</svg>
    <span>Refresh<small>{app.refreshing ? "Refreshing…" : `Updated ${ago(app.meta.updatedAt)}`}</small></span>
  </button>
  <button class="nav" class:current={app.route.name === "settings"} onclick={() => app.go({ name: "settings" })} title="Settings">
    <svg viewBox="0 0 24 24" fill="currentColor">{@html icons.settings}</svg><span>Settings</span>
    <kbd class="k">{mod},</kbd>
  </button>
</nav>
