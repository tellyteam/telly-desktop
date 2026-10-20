<script lang="ts">
  import { img } from "../lib/backend";

  /** Provider artwork through the relay, with a calm generated gradient when there's none. */
  let { src, title, fit = "cover", onfail, onsize }: {
    src?: string; title: string; fit?: "cover" | "contain"; onfail?: () => void;
    /** The image's natural width ÷ height, once it has loaded. */
    onsize?: (ratio: number) => void;
  } = $props();
  let failed = $state(false);
  const url = $derived(img(src));
  $effect(() => {
    void src;
    failed = false;
  });

  const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const gradient = $derived.by(() => {
    const h = hue(title);
    return `linear-gradient(150deg, hsl(${h} 38% 42%) 0%, hsl(${(h + 35) % 360} 42% 26%) 55%, hsl(${(h + 60) % 360} 40% 14%) 100%)`;
  });
</script>

{#if url && !failed}
  <img src={url} alt="" loading="lazy" decoding="async" draggable="false" style:object-fit={fit} onerror={() => { failed = true; onfail?.(); }}
    onload={(e) => { const i = e.currentTarget as HTMLImageElement; if (i.naturalHeight) onsize?.(i.naturalWidth / i.naturalHeight); }} />
{:else if fit === "contain"}
  <span>{title.slice(0, 14)}</span>
{:else}
  <div class="fallback" style:background={gradient}></div>
{/if}
