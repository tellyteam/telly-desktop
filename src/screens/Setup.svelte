<script lang="ts">
  import { inApp } from "../lib/backend";
  import type { Provider } from "../lib/model";
  import { app } from "../lib/state.svelte";

  let { editing = false }: { editing?: boolean } = $props();

  const existing = app.provider;
  let kind = $state<"xtream" | "m3u">(existing?.kind ?? "xtream");
  let name = $state(existing?.name ?? "");
  let server = $state(existing?.kind === "xtream" ? existing.server : "");
  let username = $state(existing?.kind === "xtream" ? existing.username : "");
  let password = $state(existing?.kind === "xtream" ? existing.password : "");
  let url = $state(existing?.kind === "m3u" ? existing.url : "");
  let allowCleartext = $state(existing?.allowCleartext ?? false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Development only: a git-ignored provider.local.properties pre-fills the form under `npm run dev`.
  if (import.meta.env.DEV && !inApp && !existing) {
    fetch("/__dev/provider").then((r) => r.json()).then((p: Record<string, string>) => {
      if (p.type === "m3u") { kind = "m3u"; url = p.url ?? ""; }
      else if (p.server) { kind = "xtream"; server = p.server; username = p.username ?? ""; password = p.password ?? ""; }
      name = p.name ?? name;
      allowCleartext = p.allowCleartext === "true";
    }).catch(() => {});
  }

  const plainHttp = $derived((kind === "xtream" ? server : url).trim().toLowerCase().startsWith("http://"));
  const ready = $derived(kind === "xtream" ? !!(server.trim() && username.trim() && password) : !!url.trim());

  async function connect(e: Event) {
    e.preventDefault();
    if (!ready || busy) return;
    if (plainHttp && !allowCleartext) {
      error = "This address uses plain HTTP. Turn on “Allow plain HTTP” below if your provider has no HTTPS.";
      return;
    }
    busy = true;
    error = null;
    const label = name.trim() || "My provider";
    const p: Provider = kind === "xtream"
      ? { kind, name: label, server: server.trim(), username: username.trim(), password, allowCleartext }
      : { kind, name: label, url: url.trim(), allowCleartext };
    try {
      await app.saveProvider(p);
    } catch (err) {
      error = (err as Error).message || "Couldn't connect.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="setup drag" data-tauri-drag-region>
  <form class="card-form" onsubmit={connect}>
    <div class="wordmark big">telly</div>
    <p class="lead">{editing ? "Your provider" : "Add your IPTV provider to start watching. telly doesn't come with any channels."}</p>
    <div class="chips" style="padding:0 0 6px">
      <button type="button" class="chip" class:sel={kind === "xtream"} onclick={() => (kind = "xtream")}>Xtream Codes</button>
      <button type="button" class="chip" class:sel={kind === "m3u"} onclick={() => (kind = "m3u")}>M3U playlist</button>
    </div>
    <div class="field"><label for="name">Name (optional)</label><input id="name" bind:value={name} placeholder="My provider" autocomplete="off" /></div>
    {#if kind === "xtream"}
      <div class="field"><label for="server">Server address</label><input id="server" bind:value={server} placeholder="example.com:8080" autocomplete="off" spellcheck="false" /></div>
      <div class="two">
        <div class="field"><label for="user">Username</label><input id="user" bind:value={username} autocomplete="off" spellcheck="false" /></div>
        <div class="field"><label for="pass">Password</label><input id="pass" type="password" bind:value={password} autocomplete="off" /></div>
      </div>
    {:else}
      <div class="field"><label for="url">Playlist address</label><input id="url" bind:value={url} placeholder="https://example.com/playlist.m3u" autocomplete="off" spellcheck="false" /></div>
    {/if}
    <div class="line" style="padding:4px 0">
      <div>Allow plain HTTP<small>Only if your provider has no HTTPS. Traffic to it won't be encrypted.</small></div>
      <button type="button" class="switch" class:on={allowCleartext} aria-label="Allow plain HTTP" onclick={() => (allowCleartext = !allowCleartext)}></button>
    </div>
    {#if error}<div class="error">{error}</div>{/if}
    <div class="btns">
      <button class="btn primary" type="submit" disabled={!ready || busy}>{busy ? "Connecting…" : editing ? "Save" : "Connect"}</button>
      {#if editing}<button class="btn" type="button" onclick={() => app.goBack() || app.go({ name: "home" })}>Cancel</button>{/if}
    </div>
    <p class="hint">Your login stays on this computer, in {navigator.platform.includes("Mac") ? "the macOS Keychain" : "Windows Credential Manager"}. telly only talks to your provider, and to GitHub once a week to check for updates.</p>
  </form>
</div>

<style>
  .setup { position: absolute; inset: 0; display: grid; place-items: center; overflow-y: auto; padding: 40px 20px; }
  .card-form { -webkit-app-region: no-drag; width: min(480px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 30px;
    background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.06); border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
  .big { font-size: 46px; padding: 0; }
  .lead { margin: 0; color: var(--muted); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { margin: 0; }
</style>
