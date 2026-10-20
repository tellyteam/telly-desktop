<script lang="ts">
  import Art from "./Art.svelte";
  import { app, type FavKind } from "../lib/state.svelte";

  let {
    variant = "poster", title, image, onclick, badge, progress, playable = false, fav, caption = true, onremove,
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
    /** Shows a ✕ on hover (Continue watching). */
    onremove?: () => void;
  } = $props();

  const on = $derived(fav ? app.isFavourite(fav.kind, fav.id) : false);
  let broken = $state(false);
  // Some providers use widescreen pictures rather than logos for channels: those fill the tile.
  let picture = $state(false);
</script>

<div class="card {variant}" class:picture role="button" tabindex="0" {onclick} onkeydown={(e) => e.key === "Enter" && onclick()} title={title}>
  <div class="art">
    {#if variant === "chan"}
      <Art src={image} {title} fit={picture ? "cover" : "contain"} onsize={(r) => (picture = r >= 1.55 && r <= 2.1)} />
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
  {#if onremove}
    <button class="heart remove" title="Remove from Continue watching" aria-label="Remove {title} from Continue watching"
      onclick={(e) => { e.stopPropagation(); onremove(); }}>✕</button>
  {/if}
  {#if caption}<div class="cap">{title}</div>{/if}
</div>
