<script lang="ts">
  import Art from "./Art.svelte";
  import { app, type FavKind } from "../lib/state.svelte";

  let {
    variant = "poster", title, image, onclick, badge, progress, playable = false, fav, caption = true,
  }: {
    variant?: "poster" | "landscape" | "chan";
    title: string;
    image?: string;
    onclick: () => void;
    badge?: string;
    progress?: number;
    playable?: boolean;
    fav?: { kind: FavKind; id: string };
    caption?: boolean;
  } = $props();

  const on = $derived(fav ? app.isFavourite(fav.kind, fav.id) : false);
  let broken = $state(false);
</script>

<div class="card {variant}" role="button" tabindex="0" {onclick} onkeydown={(e) => e.key === "Enter" && onclick()} title={title}>
  <div class="art">
    {#if variant === "chan"}
      <Art src={image} {title} fit="contain" />
    {:else}
      <Art src={image} {title} onfail={() => (broken = true)} />
      {#if !image || broken || variant === "landscape"}<div class="shade"></div><div class="ttl">{title}</div>{/if}
    {/if}
  </div>
  {#if badge}<div class="badge">{badge}</div>{/if}
  {#if progress !== undefined}<div class="bar"><div class="progress"><i style:width="{Math.round(progress * 100)}%"></i></div></div>{/if}
  {#if playable}<div class="play"><b>▶</b></div>{/if}
  {#if fav}
    <button class="heart" class:on title={on ? "Remove from My List" : "Add to My List"}
      onclick={(e) => { e.stopPropagation(); app.toggleFavourite(fav.kind, fav.id); }}>♥</button>
  {/if}
  {#if caption}<div class="cap">{title}</div>{/if}
</div>
