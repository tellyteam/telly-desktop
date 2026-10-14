<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import Art from "../components/Art.svelte";
  import { playChannel } from "../lib/actions";
  import * as G from "../lib/guide";
  import type { Channel } from "../lib/model";
  import * as repo from "../lib/repo";
  import { app } from "../lib/state.svelte";
  import { attach, type Attached } from "../lib/video";

  const FAVOURITES = "★ Favourites";
  const ALL = "All channels";

  // Start on the last channel watched, in its group.
  const last = app.history.find((h) => h.live);
  const lastChannel = last ? last.items[last.index] : undefined;

  let category = $state(lastChannel && app.live?.some((g) => g.name === lastChannel.group) ? lastChannel.group : app.live?.[0]?.name ?? ALL);
  let filter = $state("");
  let selected = $state.raw<Channel | undefined>(lastChannel);
  let guide = $state<G.Programme[]>([]);
  let names = $state<Record<string, string>>({});
  let now = $state(Date.now());
  let list: HTMLDivElement;
  let width = $state(window.innerWidth);
  // Narrow windows have no preview column, so a click goes straight to full screen.
  const narrow = $derived(width < 1000);
  let filterInput: HTMLInputElement;

  const favourites = $derived(app.favouriteItems().live);
  const channels = $derived.by(() => {
    const base = category === FAVOURITES ? favourites
      : category === ALL ? (app.live ?? []).flatMap((g) => g.items)
      : app.live?.find((g) => g.name === category)?.items ?? [];
    const q = filter.trim().toLowerCase();
    return q ? base.filter((c) => c.name.toLowerCase().includes(q)) : base;
  });
  const total = $derived((app.live ?? []).reduce((n, g) => n + g.items.length, 0));
  const nn = $derived(G.nowNext(guide, now));

  // Show a few hundred rows at a time; "All channels" can run to thousands.
  let shown = $state(200);
  $effect(() => { void channels; shown = 200; });

  // ---- Programme guide: fetched as rows come into view ----

  function visible(node: HTMLElement, c: Channel) {
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || names[c.id] !== undefined || !app.provider) return;
      io.disconnect();
      repo.programmes(app.provider, c).then((list) => {
        const n = G.nowNext(list, Date.now());
        names[c.id] = n.now?.title ?? "";
      });
    }, { root: list, rootMargin: "200px" });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  $effect(() => {
    const c = selected;
    guide = [];
    if (!c || !app.provider) return;
    let cancelled = false;
    repo.programmes(app.provider, c).then((l) => { if (!cancelled) guide = l; });
    return () => { cancelled = true; };
  });

  const clockTimer = setInterval(() => (now = Date.now()), 30_000);

  // ---- The mini player ----

  let mini = $state<HTMLVideoElement>();
  let engine: Attached | undefined;
  let miniError = $state<string | null>(null);
  let miniLoading = $state(false);
  let miniOn = $state(false);

  async function preview(c: Channel) {
    selected = c;
    miniOn = true;
    miniError = null;
    miniLoading = true;
    engine?.destroy();
    engine = undefined;
    await tick();
    if (!mini) return;
    const target = c;
    const a = await attach(mini, c.url, { live: true, onError: (m) => { if (selected === target) { miniError = m; miniLoading = false; } } });
    if (selected !== target) return a.destroy();
    engine = a;
    try { mini.volume = Number(localStorage.getItem("telly.volume") ?? "1"); } catch { /* default volume */ }
    mini.play().catch(() => {});
  }

  function stopPreview() {
    engine?.destroy();
    engine = undefined;
    miniOn = false;
  }

  /** Full screen: stop the preview first, since most providers allow one stream at a time. */
  function watch(c: Channel) {
    stopPreview();
    playChannel(c, channels.length ? channels : [c]);
  }

  // When the full player closes, the preview stays stopped until a channel is clicked again.
  onDestroy(() => {
    stopPreview();
    clearInterval(clockTimer);
  });

  function onkeydown(e: KeyboardEvent) {
    if (app.player) return;
    const mod = e.metaKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      filterInput.focus();
      return;
    }
    if (e.target instanceof HTMLInputElement && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const i = selected ? channels.findIndex((c) => c.id === selected!.id) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = channels[Math.min(channels.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        selected = next;
        stopPreview();
        tick().then(() => list.querySelector(".ch.sel")?.scrollIntoView({ block: "nearest" }));
      }
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      watch(selected);
    } else if (e.key === " " && selected && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (miniOn) stopPreview(); else void preview(selected);
    }
  }

  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const minsLeft = (p: G.Programme) => Math.max(0, Math.round((p.end - now) / 60_000));
  const number = (c: Channel) => channels.findIndex((x) => x.id === c.id) + 1;
</script>

<svelte:window {onkeydown} bind:innerWidth={width} />

<div class="live">
  <div class="col cats" data-tauri-drag-region>
    <h2 data-tauri-drag-region>Live TV</h2>
    <button class="cat" class:sel={category === FAVOURITES} onclick={() => (category = FAVOURITES)}><span>{FAVOURITES}</span><span>{favourites.length}</span></button>
    <button class="cat" class:sel={category === ALL} onclick={() => (category = ALL)}><span>{ALL}</span><span>{total.toLocaleString()}</span></button>
    {#each app.live ?? [] as g (g.name)}
      <button class="cat" class:sel={category === g.name} onclick={() => (category = g.name)} title={g.name}><span>{g.name}</span><span>{g.items.length}</span></button>
    {/each}
  </div>

  <div class="col chlist" bind:this={list}>
    <div class="filter"><label class="search-box"><span>⌕</span><input bind:this={filterInput} bind:value={filter} placeholder="Filter {category === ALL ? 'all channels' : category}" spellcheck="false" />
      <kbd>⌘F</kbd></label></div>
    {#each channels.slice(0, shown) as c, i (c.id)}
      {@const fav = app.isFavourite("live", c.id)}
      <div class="ch" class:sel={selected?.id === c.id} role="button" tabindex="0" use:visible={c}
        onclick={() => (narrow ? watch(c) : preview(c))} ondblclick={() => watch(c)} onkeydown={(e) => e.key === "Enter" && watch(c)}>
        <span class="num">{i + 1}</span>
        <span class="logo"><Art src={c.logo} title={c.name} fit="contain" /></span>
        <span class="nm">{c.name}<small>{names[c.id] ?? " "}</small></span>
        <button class="star" class:on={fav} title={fav ? "Remove from favourites" : "Add to favourites"}
          onclick={(e) => { e.stopPropagation(); app.toggleFavourite("live", c.id); }}>★</button>
      </div>
    {:else}
      <div class="empty" style="padding:20px 10px">{category === FAVOURITES ? "Click ★ next to a channel to add it here." : filter ? "No channels match." : "No channels in this category."}</div>
    {/each}
    {#if shown < channels.length}<button class="btn small" style="margin:10px" onclick={() => (shown += 400)}>Show more ({(channels.length - shown).toLocaleString()} left)</button>{/if}
  </div>

  <div class="col preview">
    {#if selected}
      <div class="mini" role="button" tabindex="-1" onclick={() => (miniOn ? watch(selected!) : preview(selected!))} ondblclick={() => watch(selected!)} onkeydown={() => {}}>
        {#if miniOn}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={mini} playsinline onplaying={() => (miniLoading = false)}></video>
          <span class="live-dot">LIVE</span>
          {#if miniLoading && !miniError}<div class="msg"><div class="spinner"></div></div>{/if}
          {#if miniError}<div class="msg">{miniError}</div>{/if}
          <span class="expand">⤢ Full screen · double-click or Enter</span>
        {:else}
          <div class="msg"><span><b style="font-size:28px">▶</b><br />Click to preview · Enter for full screen</span></div>
        {/if}
      </div>
      <h4>{number(selected) || ""}{number(selected) ? " · " : ""}{selected.name}</h4>
      <div class="btns">
        <button class="btn primary small" onclick={() => watch(selected!)}>▶ Watch</button>
        <button class="btn small" class:on={app.isFavourite("live", selected.id)} onclick={() => app.toggleFavourite("live", selected!.id)}>{app.isFavourite("live", selected.id) ? "★ Favourite" : "☆ Favourite"}</button>
      </div>
      <div class="guide">
        {#each guide.filter((p) => p.end > now).slice(0, 6) as p (p.start)}
          {@const isNow = p === nn.now}
          <div class="slot" class:now={isNow}>
            <time>{time(p.start)}</time>
            <div><b>{p.title}</b>
              {#if isNow}<div class="progress" style="margin:6px 0 2px"><i style:width="{G.progress(p, now) * 100}%"></i></div>
                <p>{minsLeft(p)} min left{p.description ? ` · ${p.description}` : ""}</p>
              {:else if p.description}<p>{p.description}</p>{/if}</div>
          </div>
        {:else}
          <div class="hint">{app.provider?.kind === "m3u" ? "Programme guides for M3U playlists aren't supported yet." : "No programme guide for this channel."}</div>
        {/each}
      </div>
    {:else}
      <div class="empty" style="padding:30px 0">Click a channel to preview it. Double-click, or press Enter, to watch full screen. ↑ ↓ move through the list.</div>
    {/if}
  </div>
</div>
