<script lang="ts">
  import type { Snippet } from "svelte";
  import { app } from "../lib/state.svelte";

  let { placeholder = "Search films, series and channels", search = true, children }: { placeholder?: string; search?: boolean; children?: Snippet } = $props();
</script>

<div class="topbar">
  {@render children?.()}
  {#if search}
    <button class="search-box" onclick={() => app.go({ name: "search" })}><span class="icon">⌕</span> <span class="label">{placeholder}</span> <kbd>⌘K</kbd></button>
  {/if}
</div>
