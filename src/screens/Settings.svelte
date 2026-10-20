<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import { inApp, isWebOS, openExternal, vlcAvailable } from "../lib/backend";
  import { ago, app, DEFAULT_RELAY } from "../lib/state.svelte";
  import { formatCode } from "../lib/sync/crypto";
  import { syncLink } from "../lib/sync/link";
  import QrCode from "../components/QrCode.svelte";
  import { RELEASES_PAGE } from "../lib/updates";

  let vlc = $state(false);
  let confirmSignOut = $state(false);
  let clearing = $state(false);
  let confirmClearProgress = $state(false);
  vlcAvailable().then((v) => (vlc = v));

  let joining = $state(false);
  let joinCode = $state("");
  let relay = $state(DEFAULT_RELAY);
  let showCode = $state(true);
  let linking = $state(false);
  let syncError = $state<string | null>(null);

  async function link(code?: string) {
    linking = true;
    syncError = null;
    try {
      await app.startSync(code, relay.trim());
      joining = false;
      joinCode = "";
      showCode = true;
    } catch (e) {
      syncError = (e as Error).message;
      if (!app.syncStatus.at) await app.stopSync();
    } finally {
      linking = false;
    }
  }

  // Seven clicks on the version in a row show (or hide) the Sync section.
  let versionClicks = 0;
  let versionTimer: ReturnType<typeof setTimeout> | undefined;
  let unlockNote = $state<string | null>(null);
  function clickVersion() {
    clearTimeout(versionTimer);
    versionTimer = setTimeout(() => (versionClicks = 0), 3000);
    if (++versionClicks < 7) return;
    versionClicks = 0;
    unlockNote = app.toggleSyncUnlocked() ? "Sync is now in Settings." : "Sync hidden.";
    setTimeout(() => (unlockNote = null), 3000);
  }

  const p = $derived(app.provider!);
  const toggle = (key: "autoNext" | "offerVlc") => { app.settings[key] = !app.settings[key]; app.saveSettings(); };
</script>

<div class="screen">
  <TopBar search={false} />
  <div class="page-head" style="padding-bottom:14px"><h2>Settings</h2></div>
  <div class="settings">
    <div class="panel"><h4>Provider</h4>
      <div class="line"><div>{p.name}<small>{p.kind === "xtream" ? "Xtream Codes" : "M3U playlist"} · login kept {isWebOS ? "on this TV" : inApp ? "in the macOS Keychain" : "in this browser (development)"}</small></div>
        <div class="btns"><button class="btn small" onclick={() => app.go({ name: "setup", editing: true })}>Edit</button>
          {#if confirmSignOut}<button class="btn small" onclick={() => app.signOut()}>Sign out and forget it</button><button class="btn small" onclick={() => (confirmSignOut = false)}>Cancel</button>
          {:else}<button class="btn small" onclick={() => (confirmSignOut = true)}>Sign out</button>{/if}</div></div>
      <div class="line"><div>Allow plain HTTP for this provider<small>Only if it has no HTTPS. Traffic to it won't be encrypted.</small></div>
        <button class="switch" class:on={p.allowCleartext} aria-label="Allow plain HTTP" onclick={() => app.setAllowCleartext(!p.allowCleartext)}></button></div>
    </div>
    <div class="panel"><h4>Playback</h4>
      <div class="line"><div>Play the next episode automatically<small>When the credits start, a countdown offers the next one</small></div>
        <button class="switch" class:on={app.settings.autoNext} aria-label="Play the next episode automatically" onclick={() => toggle("autoNext")}></button></div>
      {#if !isWebOS}
      <div class="line"><div>Offer VLC when a stream won't play here<small>{vlc ? "VLC is installed" : "Install VLC (videolan.org) to play the odd format telly can't"}</small></div>
        <button class="switch" class:on={app.settings.offerVlc} aria-label="Offer VLC" onclick={() => toggle("offerVlc")}></button></div>
      <div class="line"><div>Keyboard<small>Space pause · ← → 10 seconds · ↑ ↓ volume · F full screen · N next episode · M mute · Esc back</small></div></div>
      {:else}
      <div class="line"><div>Remote<small>OK play or pause · ◀ ▶ 10 seconds · CH + / − change channel · Back to leave</small></div></div>
      {/if}
    </div>
    {#if app.syncShown}
    <div class="panel"><h4>Sync</h4>
      {#if app.sync}
        <div class="line"><div>Keeping your place in sync<small>{app.syncStatus.busy ? "Syncing now…" : `Last synced ${ago(app.syncStatus.at)}`}{app.syncStatus.error ? ` · ${app.syncStatus.error}` : ""}</small></div>
          <div class="btns"><button class="btn small" disabled={app.syncStatus.busy} onclick={() => app.syncNow()}>Sync now</button>
            <button class="btn small" onclick={() => app.stopSync()}>Stop syncing on this {isWebOS ? "TV" : "Mac"}</button></div></div>
        <div class="line"><div>Link another device<small>Scan the QR code with your iPad's camera, or enter the code in Settings → Sync on your Fire TV or iPad. Keep it private: anyone with it can see what you've watched.</small></div>
          <button class="btn small" onclick={() => (showCode = !showCode)}>{showCode ? "Hide code" : "Show code"}</button></div>
        {#if showCode}
          <div class="line sync-link"><QrCode text={syncLink(app.sync.code, app.sync.relay, DEFAULT_RELAY)} /><code class="sync-code">{formatCode(app.sync.code)}</code></div>
        {/if}
      {:else}
        <div class="line"><div>Pick up where you left off on your other devices<small>Shares progress, Continue watching and My List, end-to-end encrypted. Your provider login is never shared; sign in on each device.</small></div>
          <div class="btns"><button class="btn small primary" disabled={linking || !relay.trim()} onclick={() => link()}>Start syncing</button>
            <button class="btn small" disabled={linking} onclick={() => (joining = !joining)}>I have a code</button></div></div>
        {#if joining}
          <div class="line"><div class="field" style="flex:1"><input placeholder="ABCD-EFGH-JKMN-PQRS" bind:value={joinCode} maxlength="19" spellcheck="false" autocomplete="off" /></div>
            <button class="btn small primary" disabled={linking || !joinCode.trim() || !relay.trim()} onclick={() => link(joinCode)}>{linking ? "Linking…" : "Link"}</button></div>
        {/if}
        <div class="line"><div>Relay<small>Only sealed data passes through it. Change this only if you run your own.</small></div>
          <div class="field" style="width:320px"><input placeholder="https://…" bind:value={relay} spellcheck="false" autocomplete="off" /></div></div>
        {#if syncError}<div class="notice">{syncError}</div>{/if}
      {/if}
    </div>
    {/if}
    <div class="panel"><h4>{isWebOS ? "About" : "Updates"}</h4>
      {#if app.update.latest}
        <div class="notice" style="margin-bottom:8px">telly {app.update.latest.version} is available.{#if app.update.latest.notes}<br /><small>{app.update.latest.notes.split("\n")[0]}</small>{/if}</div>
      {/if}
      <div class="line"><div><span role="button" tabindex={isWebOS ? 0 : -1} onclick={clickVersion} onkeydown={() => {}}>telly {app.update.current}</span>{#if unlockNote} <span class="hint">· {unlockNote}</span>{/if}<small>{isWebOS ? "Installed from your computer in Developer Mode" : `Checks GitHub once a week · last checked ${ago(app.meta.updateCheckedAt)}`}{app.update.upToDate ? " · You're up to date" : ""}{app.update.error ? ` · ${app.update.error}` : ""}</small></div>
        {#if !isWebOS}
        <div class="btns">
          {#if app.update.latest}
            <button class="btn small primary" disabled={app.update.installing !== undefined} onclick={() => app.installUpdate()}>
              {app.update.installing !== undefined ? `Installing… ${Math.round(app.update.installing * 100)}%` : `Install ${app.update.latest.version} and restart`}</button>
            <button class="btn small" onclick={() => openExternal(app.update.latest!.page)}>Download</button>
          {/if}
          <button class="btn small" disabled={app.update.checking} onclick={() => app.checkForUpdate(true)}>{app.update.checking ? "Checking…" : "Check now"}</button>
          <button class="btn small" onclick={() => openExternal(RELEASES_PAGE)}>Releases</button>
        </div>
        {/if}</div>
    </div>
    <div class="panel"><h4>Data</h4>
      <div class="line"><div>Refresh lists<small>{app.refreshing ? "Refreshing now…" : `Films, series and channels were updated ${ago(app.meta.updatedAt)}`}</small></div>
        <button class="btn small" disabled={app.refreshing} onclick={() => app.refresh()}>Refresh</button></div>
      <div class="line"><div>Clear saved lists<small>Downloads everything afresh. Your login, My List and progress are kept.</small></div>
        <button class="btn small" disabled={clearing || app.refreshing} onclick={async () => { clearing = true; await app.clearSavedData(); clearing = false; }}>{clearing ? "Clearing…" : "Clear"}</button></div>
      <div class="line"><div>Clear watch progress<small>Forgets where you got to in every film and episode, and empties Continue watching. My List is kept.{app.sync ? " Your linked devices are cleared too." : ""}</small></div>
        {#if confirmClearProgress}<div class="btns"><button class="btn small" onclick={() => { app.clearProgress(); confirmClearProgress = false; }}>Clear it all</button><button class="btn small" onclick={() => (confirmClearProgress = false)}>Cancel</button></div>
        {:else}<button class="btn small" onclick={() => (confirmClearProgress = true)}>Clear</button>{/if}</div>
    </div>
    <p class="hint">telly is free software (GPL-3.0). It talks only to your provider{isWebOS ? "" : " and to GitHub once a week to check for updates"}{app.syncShown ? ", and to the sync relay if you turn on sync" : ""}. No accounts, analytics or tracking.</p>
  </div>
</div>
