<script lang="ts">
  import { onMount } from "svelte";
  import Rail from "./components/Rail.svelte";
  import { flushWrites } from "./lib/backend";
  import { app } from "./lib/state.svelte";
  import Catalog from "./screens/Catalog.svelte";
  import FilmDetail from "./screens/FilmDetail.svelte";
  import Grid from "./screens/Grid.svelte";
  import Home from "./screens/Home.svelte";
  import Live from "./screens/Live.svelte";
  import MyList from "./screens/MyList.svelte";
  import Player from "./screens/Player.svelte";
  import Search from "./screens/Search.svelte";
  import SeriesDetail from "./screens/SeriesDetail.svelte";
  import Settings from "./screens/Settings.svelte";
  import Setup from "./screens/Setup.svelte";

  let width = $state(window.innerWidth);
  onMount(() => {
    void app.start();
    const save = () => flushWrites();
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  });

  const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

  function onkeydown(e: KeyboardEvent) {
    if (app.player || !app.provider) return; // the player and setup handle their own keys
    const mod = e.metaKey;
    if ((mod && e.key.toLowerCase() === "k") || (e.key === "/" && !typing(e.target))) {
      e.preventDefault();
      app.go({ name: "search" });
    } else if (mod && "12345".includes(e.key) && e.key.length === 1) {
      e.preventDefault();
      app.go({ name: (["home", "live", "series", "films", "mylist"] as const)[Number(e.key) - 1] });
    } else if (mod && e.key === ",") {
      e.preventDefault();
      app.go({ name: "settings" });
    } else if (mod && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void app.refresh();
    } else if (e.key === "Escape" || (mod && e.key === "[")) {
      if (typing(e.target)) (e.target as HTMLElement).blur();
      else app.goBack();
    }
  }
</script>

<svelte:window bind:innerWidth={width} {onkeydown} />

<div class="window" class:narrow={width < 1000}>
  {#if !app.ready}
    <div class="center"><div class="spinner"></div></div>
  {:else if app.route.name === "setup" || !app.provider}
    <Setup editing={app.route.name === "setup" ? app.route.editing : undefined} adding={app.route.name === "setup" && !!app.route.adding} />
  {:else}
    <Rail />
    <main class="main">
      {#key app.route}
        {#if app.loadError && !app.live}
          <div class="screen"><div class="topbar"></div>
            <div class="empty"><b>Couldn't load your lists</b>{app.loadError}
              <div class="btns" style="margin-top:16px"><button class="btn primary" onclick={() => app.refresh()}>Try again</button>
                <button class="btn" onclick={() => app.go({ name: "setup", editing: app.activeId ?? undefined })}>Check provider details</button></div></div></div>
        {:else if app.route.name === "home"}<Home />
        {:else if app.route.name === "live"}<Live />
        {:else if app.route.name === "series"}<Catalog kind="series" />
        {:else if app.route.name === "films"}<Catalog kind="films" />
        {:else if app.route.name === "grid"}<Grid kind={app.route.kind} group={app.route.group} />
        {:else if app.route.name === "seriesDetail"}<SeriesDetail series={app.route.series} />
        {:else if app.route.name === "filmDetail"}<FilmDetail film={app.route.film} />
        {:else if app.route.name === "mylist"}<MyList />
        {:else if app.route.name === "search"}<Search />
        {:else if app.route.name === "settings"}<Settings />
        {/if}
      {/key}
    </main>
  {/if}
  {#if app.player}{#key app.player}<Player request={app.player} />{/key}{/if}
</div>
