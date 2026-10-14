<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import { inApp, isMac, openExternal, vlcAvailable } from "../lib/backend";
  import { ago, app } from "../lib/state.svelte";
  import { RELEASES_PAGE } from "../lib/updates";

  let vlc = $state(false);
  let confirmSignOut = $state(false);
  let clearing = $state(false);
  vlcAvailable().then((v) => (vlc = v));

  const p = $derived(app.provider!);
  const toggle = (key: "autoNext" | "offerVlc") => { app.settings[key] = !app.settings[key]; app.saveSettings(); };
</script>

<div class="screen">
  <TopBar search={false} />
  <div class="page-head" style="padding-bottom:14px"><h2>Settings</h2></div>
  <div class="settings">
    <div class="panel"><h4>Provider</h4>
      <div class="line"><div>{p.name}<small>{p.kind === "xtream" ? "Xtream Codes" : "M3U playlist"} · login kept in {isMac ? "the macOS Keychain" : inApp ? "Windows Credential Manager" : "this browser (development)"}</small></div>
        <div class="btns"><button class="btn small" onclick={() => app.go({ name: "setup", editing: true })}>Edit</button>
          {#if confirmSignOut}<button class="btn small" onclick={() => app.signOut()}>Sign out and forget it</button><button class="btn small" onclick={() => (confirmSignOut = false)}>Cancel</button>
          {:else}<button class="btn small" onclick={() => (confirmSignOut = true)}>Sign out</button>{/if}</div></div>
      <div class="line"><div>Allow plain HTTP for this provider<small>Only if it has no HTTPS. Traffic to it won't be encrypted.</small></div>
        <button class="switch" class:on={p.allowCleartext} aria-label="Allow plain HTTP" onclick={() => app.setAllowCleartext(!p.allowCleartext)}></button></div>
    </div>
    <div class="panel"><h4>Playback</h4>
      <div class="line"><div>Play the next episode automatically<small>When the credits start, a countdown offers the next one</small></div>
        <button class="switch" class:on={app.settings.autoNext} aria-label="Play the next episode automatically" onclick={() => toggle("autoNext")}></button></div>
      <div class="line"><div>Offer VLC when a stream won't play here<small>{vlc ? "VLC is installed" : "Install VLC (videolan.org) to play the odd format telly can't"}</small></div>
        <button class="switch" class:on={app.settings.offerVlc} aria-label="Offer VLC" onclick={() => toggle("offerVlc")}></button></div>
      <div class="line"><div>Keyboard<small>Space pause · ← → 10 seconds · ↑ ↓ volume · F full screen · N next episode · M mute · Esc back</small></div></div>
    </div>
    <div class="panel"><h4>Updates</h4>
      {#if app.update.latest}
        <div class="notice" style="margin-bottom:8px">telly {app.update.latest.version} is available.{#if app.update.latest.notes}<br /><small>{app.update.latest.notes.split("\n")[0]}</small>{/if}</div>
      {/if}
      <div class="line"><div>telly {app.update.current}<small>Checks GitHub once a week · last checked {ago(app.meta.updateCheckedAt)}{app.update.error ? ` · ${app.update.error}` : ""}</small></div>
        <div class="btns">
          {#if app.update.latest}<button class="btn small primary" onclick={() => openExternal(app.update.latest!.page)}>Download {app.update.latest.version}</button>{/if}
          <button class="btn small" disabled={app.update.checking} onclick={() => app.checkForUpdate(true)}>{app.update.checking ? "Checking…" : "Check now"}</button>
          <button class="btn small" onclick={() => openExternal(RELEASES_PAGE)}>Releases</button>
        </div></div>
    </div>
    <div class="panel"><h4>Data</h4>
      <div class="line"><div>Refresh lists<small>{app.refreshing ? "Refreshing now…" : `Films, series and channels were updated ${ago(app.meta.updatedAt)}`}</small></div>
        <button class="btn small" disabled={app.refreshing} onclick={() => app.refresh()}>Refresh</button></div>
      <div class="line"><div>Clear saved lists<small>Downloads everything afresh. Your login, My List and progress are kept.</small></div>
        <button class="btn small" disabled={clearing || app.refreshing} onclick={async () => { clearing = true; await app.clearSavedData(); clearing = false; }}>{clearing ? "Clearing…" : "Clear"}</button></div>
    </div>
    <p class="hint">telly is free software (GPL-3.0). It talks only to your provider, and to GitHub once a week to check for updates. No accounts, analytics or tracking.</p>
  </div>
</div>
