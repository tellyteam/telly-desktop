<script lang="ts">
  import type { Snippet } from "svelte";
  import { app } from "../lib/state.svelte";

  let { placeholder = "Search films, series and channels", search = true, children }: { placeholder?: string; search?: boolean; children?: Snippet } = $props();
</script>

<div class="topbar drag" data-tauri-drag-region>
  {@render children?.()}
  {#if search}
    <button class="search-box" onclick={() => app.go({ name: "search" })}>⌕ {placeholder} <kbd>⌘K</kbd></button>
  {/if}
</div>
