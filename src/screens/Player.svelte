<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { isFullscreen, openInVlc, setFullscreen, vlcAvailable } from "../lib/backend";
  import * as P from "../lib/playback";
  import { app, type PlayRequest } from "../lib/state.svelte";
  import { attach, type Attached, type Track } from "../lib/video";

  // The player is re-created for every request (it is keyed), so reading the initial request is intended.
  let { request }: { request: PlayRequest } = $props();

  // svelte-ignore state_referenced_locally
  let index = $state(request.index);
  const item = $derived(request.items[index]);
  // svelte-ignore state_referenced_locally
  const live = request.live;
  const hasNext = $derived(!live && index + 1 < request.items.length);

  let video: HTMLVideoElement;
  let stage: HTMLDivElement;
  let engine: Attached | undefined;
  let playing = $state(false);
  let waiting = $state(true);
  let time = $state(0);
  let duration = $state(0);
  let error = $state<string | null>(null);
  let vlc = $state(false);
  let awake = $state(true);
  let menu = $state<"aspect" | "tracks" | "speed" | null>(null);
  let toast = $state<string | null>(null);
  let speed = $state(1);
  let volume = $state(loadVolume());
  let muted = $state(false);
  let fullscreen = $state(false);
  let audio = $state<Track[]>([]);
  let audioSel = $state(-1);
  let subs = $state<Track[]>([]);
  let subSel = $state(-1);
  // svelte-ignore state_referenced_locally
  let aspect = $state<P.Aspect>(app.aspectFor(request.aspectKey));
  let adjusting = $state(false);
  let box = $state({ w: 0, h: 0, vw: 0, vh: 0 });
  let nextDismissed = $state(false);
  let lastSaved = 0;
  let wakeLock: WakeLockSentinel | null = null;

  function loadVolume() {
    try {
      return Math.min(1, Math.max(0, Number(localStorage.getItem("telly.volume") ?? "1")));
    } catch {
      return 1;
    }
  }

  // ---- Loading a stream (again on every episode or channel change) ----

  let loadId = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /**
   * Some formats (MKV files on a Mac, notably) are downloaded but never decoded, and the video
   * element raises no error. If nothing has started after this long, say so and offer VLC.
   */
  const STALL_MS = 20_000;
  async function load(i: number, startAt?: number) {
    const id = ++loadId;
    saveProgress();
    engine?.destroy();
    engine = undefined;
    error = null;
    waiting = true;
    time = duration = 0;
    nextDismissed = false;
    audio = subs = [];
    const target = request.items[i];
    const resumeAt = live ? 0 : startAt ?? P.resumePosition(app.progressOf(target.url));
    const attached = await attach(video, target.url, {
      live,
      onError: (msg) => { if (id === loadId) { error = msg; waiting = false; } },
      onTracks: readTracks,
    });
    if (id !== loadId) return attached.destroy();
    engine = attached;
    video.playbackRate = speed;
    if (resumeAt > 0) {
      const seek = () => { video.currentTime = resumeAt / 1000; };
      if (video.readyState >= 1) seek(); else video.addEventListener("loadedmetadata", seek, { once: true });
    }
    video.play().catch(() => {});
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (id === loadId && !error && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        error = "This video's format can't be played here.";
        waiting = false;
        engine?.destroy();
        engine = undefined;
      }
    }, STALL_MS);
  }

  function go(i: number, startAt?: number) {
    if (i < 0 || i >= request.items.length) return;
    index = i;
    app.recordWatching(request, i);
    if (live) {
      // Each channel keeps its own aspect.
      aspect = app.aspectFor(`live:${request.items[i].id}`);
    }
    void load(i, startAt);
    flash(live ? request.items[i].name : "");
  }

  function readTracks() {
    if (!engine) return;
    audio = engine.audioTracks();
    audioSel = engine.audioTrack();
    subs = engine.subtitleTracks();
    subSel = engine.subtitleTrack();
  }

  function saveProgress(force = false) {
    if (live || !video || !item) return;
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    app.saveProgress(item.url, video.currentTime * 1000, d * 1000);
  }

  // ---- Events from the video ----

  function ontimeupdate() {
    time = video.currentTime * 1000;
    duration = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    saveProgress();
  }

  function onended() {
    if (live) return;
    app.saveProgress(item.url, duration, duration);
    if (hasNext && app.settings.autoNext) go(index + 1, 0);
    else close();
  }

  const remaining = $derived(duration ? duration - time : Infinity);
  const showNext = $derived(hasNext && app.settings.autoNext && !nextDismissed && !error && remaining <= P.END_MARGIN_MS && remaining > 0);

  // ---- Controls ----

  let idle: ReturnType<typeof setTimeout>;
  function wake() {
    awake = true;
    clearTimeout(idle);
    idle = setTimeout(() => { if (!menu && !adjusting && playing) awake = false; }, 3000);
  }

  let toastTimer: ReturnType<typeof setTimeout>;
  function flash(text: string) {
    if (!text) return;
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 900);
  }

  function togglePlay() {
    if (error) return;
    if (video.paused) { video.play().catch(() => {}); flash("▶"); } else { video.pause(); flash("❚❚"); }
  }

  function seekBy(ms: number) {
    if (live || !duration) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + ms / 1000), video.duration - 1);
    flash(ms > 0 ? `+${ms / 1000}s` : `−${-ms / 1000}s`);
  }

  function setVolume(v: number) {
    volume = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
    muted = false;
    try { localStorage.setItem("telly.volume", String(volume)); } catch { /* per-device nicety only */ }
    flash(`Volume ${Math.round(volume * 100)}%`);
  }

  async function toggleFullscreen() {
    fullscreen = !(await isFullscreen());
    await setFullscreen(fullscreen);
  }

  async function togglePip() {
    const v = video as HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string };
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
    } catch {
      flash("Picture in picture isn't available");
    }
  }

  async function close() {
    saveProgress(true);
    if (await isFullscreen()) await setFullscreen(false);
    app.player = null;
  }

  function chooseAspect(a: P.Aspect) {
    aspect = a.kind === "custom" && aspect.kind === "custom" ? aspect : a;
    app.saveAspect(live ? `live:${item.id}` : request.aspectKey, aspect);
    if (a.kind === "custom") { adjusting = true; menu = null; } else { adjusting = false; menu = null; }
  }

  function nudge(dw: number, dh: number) {
    if (aspect.kind !== "custom") return;
    const r = (n: number) => Math.round(Math.min(2, Math.max(0.5, n)) * 100) / 100;
    aspect = { kind: "custom", w: r(aspect.w + dw), h: r(aspect.h + dh) };
    app.saveAspect(live ? `live:${item.id}` : request.aspectKey, aspect);
  }

  async function playInVlc() {
    try {
      await openInVlc(item.url, live ? item.name : `${request.heading} – ${item.name}`);
      void close();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  // ---- Scrubbing ----

  let scrub = $state<HTMLDivElement>()!;
  let hoverMs = $state<number | null>(null);
  let hoverX = $state(0);
  let dragging = false;
  const posAt = (e: PointerEvent) => {
    const r = scrub.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    hoverX = f * 100;
    return f * duration;
  };
  function scrubDown(e: PointerEvent) {
    if (live || !duration) return;
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    time = posAt(e);
  }
  function scrubMove(e: PointerEvent) {
    if (live || !duration) return;
    hoverMs = posAt(e);
    if (dragging) time = hoverMs;
  }
  function scrubUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    video.currentTime = posAt(e) / 1000;
  }

  // ---- Keyboard ----

  function onkeydown(e: KeyboardEvent) {
    wake();
    const k = e.key;
    if (adjusting) {
      const step = e.shiftKey ? 0.05 : 0.01;
      if (k === "ArrowLeft") nudge(-step, 0); else if (k === "ArrowRight") nudge(step, 0);
      else if (k === "ArrowUp") nudge(0, step); else if (k === "ArrowDown") nudge(0, -step);
      else if (k === "Enter" || k === "Escape") adjusting = false;
      else if (k === "0") nudge(1 - (aspect as { w: number }).w, 1 - (aspect as { h: number }).h);
      e.preventDefault();
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      if (menu) menu = null;
      else void isFullscreen().then((f) => (f ? setFullscreen((fullscreen = false)) : close()));
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const handled = true;
    switch (k) {
      case " ": case "k": togglePlay(); break;
      case "ArrowLeft": case "j": seekBy(-10_000); break;
      case "ArrowRight": case "l": seekBy(10_000); break;
      case "ArrowUp": setVolume(volume + 0.05); break;
      case "ArrowDown": setVolume(volume - 0.05); break;
      case "f": void toggleFullscreen(); break;
      case "m": muted = !muted; flash(muted ? "Muted" : "Sound on"); break;
      case "p": void togglePip(); break;
      case "n": if (hasNext) go(index + 1, 0); break;
      case "PageUp": case "[": if (live) go((index - 1 + request.items.length) % request.items.length); break;
      case "PageDown": case "]": if (live) go((index + 1) % request.items.length); break;
      case "a": menu = menu === "aspect" ? null : "aspect"; break;
      default: return;
    }
    if (handled) e.preventDefault();
  }

  // ---- Aspect as a scale on the fitted picture ----

  const scale = $derived.by(() => {
    const [fw, fh] = P.fitted(box.vw, box.vh, box.w, box.h);
    return P.aspectScale(aspect, fw, fh, box.w, box.h);
  });

  function measure() {
    box = { w: stage.clientWidth, h: stage.clientHeight, vw: video.videoWidth, vh: video.videoHeight };
  }

  // ---- Keep the screen awake while something plays ----

  $effect(() => {
    if (playing && "wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then((l) => (wakeLock = l)).catch(() => {});
    } else {
      wakeLock?.release().catch(() => {});
      wakeLock = null;
    }
  });

  $effect(() => { if (video) { video.volume = volume; video.muted = muted; } });
  $effect(() => { if (video) video.playbackRate = speed; });

  onMount(() => {
    vlcAvailable().then((v) => (vlc = v && app.settings.offerVlc));
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    void load(index, request.startAt);
    wake();
    return () => ro.disconnect();
  });

  onDestroy(() => {
    saveProgress(true);
    loadId++;
    engine?.destroy();
    wakeLock?.release().catch(() => {});
    clearTimeout(idle);
    clearTimeout(toastTimer);
    clearTimeout(watchdog);
  });

  const title = $derived(live ? item.name : P.isFilm({ heading: request.heading, live, index, items: request.items, at: 0 }) ? item.name : request.heading);
  const subtitle = $derived(live ? `${index + 1} of ${request.items.length} · ${item.group}` : P.isFilm({ heading: request.heading, live, index, items: request.items, at: 0 }) ? item.group : `${item.group} · ${item.name}`);
  const nextItem = $derived(hasNext ? request.items[index + 1] : undefined);
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="player" class:awake={awake || !playing || !!error} onmousemove={wake} bind:this={stage}>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} playsinline
    style:transform="scale({scale[0]}, {scale[1]})"
    onplay={() => (playing = true)} onpause={() => (playing = false)}
    onwaiting={() => (waiting = true)} onplaying={() => (waiting = false)} oncanplay={() => (waiting = false)}
    {ontimeupdate} {onended} onloadedmetadata={() => { measure(); readTracks(); }} onresize={measure}
    onclick={togglePlay} ondblclick={toggleFullscreen}></video>

  {#if waiting && !error}<div class="center" style="pointer-events:none"><div class="spinner"></div></div>{/if}
  {#if toast}<div class="toast">{toast}</div>{/if}

  {#if error}
    <div class="failure">
      <b>{error}</b>
      <span>{live ? "The channel may be off air, or your provider may limit how many streams play at once." : "Some providers' files use formats this computer's video engine can't decode."}</span>
      <div class="btns">
        <button class="btn primary" onclick={() => load(index)}>Try again</button>
        {#if vlc}<button class="btn" onclick={playInVlc}>Open in VLC</button>{/if}
        {#if live && request.items.length > 1}<button class="btn" onclick={() => go((index + 1) % request.items.length)}>Next channel</button>{/if}
        <button class="btn" onclick={close}>Close</button>
      </div>
    </div>
  {/if}

  <div class="ui">
    <div class="ov-top drag" data-tauri-drag-region>
      <button class="back" aria-label="Back" onclick={close}>‹</button>
      <div><div class="t">{title}</div><div class="s">{subtitle}</div></div>
    </div>

    {#if showNext && nextItem}
      <button class="nextp" onclick={() => go(index + 1, 0)}>
        <b>▶ Next episode in {Math.max(0, Math.ceil(remaining / 1000))}s</b>{nextItem.name}
        <span class="x" role="button" tabindex="-1" aria-label="Dismiss" onclick={(e) => { e.stopPropagation(); nextDismissed = true; }} onkeydown={() => {}}>✕</span>
      </button>
    {/if}

    {#if adjusting && aspect.kind === "custom"}
      <div class="adjust">
        <b>Custom picture size</b>
        <span>← → width {Math.round(aspect.w * 100)}% · ↑ ↓ height {Math.round(aspect.h * 100)}%</span>
        <span class="hint">Hold Shift for bigger steps · 0 resets · Enter when done</span>
        <div class="btns"><button class="btn small" onclick={() => (adjusting = false)}>Done</button></div>
      </div>
    {/if}

    {#if menu === "aspect"}
      <div class="menu"><h4>Aspect ratio</h4>
        {#each P.ASPECTS as a (a.label)}<button class="opt" class:sel={a.aspect.kind === aspect.kind} onclick={() => chooseAspect(a.aspect)}>{a.label}</button>{/each}
        <div class="hint" style="padding:6px 10px 2px">Remembered for this {live ? "channel" : P.isFilm({ heading: request.heading, live, index, items: request.items, at: 0 }) ? "film" : "series"}</div>
      </div>
    {:else if menu === "tracks"}
      <div class="menu"><h4>Audio</h4>
        {#each audio as t (t.id)}<button class="opt" class:sel={t.id === audioSel} onclick={() => { engine?.setAudioTrack(t.id); audioSel = t.id; }}>{t.label}</button>
        {:else}<div class="hint" style="padding:4px 10px">Only one audio track</div>{/each}
        <h4 style="margin-top:10px">Subtitles</h4>
        <button class="opt" class:sel={subSel < 0} onclick={() => { engine?.setSubtitleTrack(-1); subSel = -1; }}>Off</button>
        {#each subs as t (t.id)}<button class="opt" class:sel={t.id === subSel} onclick={() => { engine?.setSubtitleTrack(t.id); subSel = t.id; }}>{t.label}</button>{/each}
      </div>
    {:else if menu === "speed"}
      <div class="menu"><h4>Speed</h4>
        {#each [0.75, 1, 1.25, 1.5, 2] as s}<button class="opt" class:sel={s === speed} onclick={() => { speed = s; menu = null; }}>{s === 1 ? "Normal" : `${s}×`}</button>{/each}
      </div>
    {/if}

    <div class="ov-bottom">
      {#if !live}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="scrub" bind:this={scrub} onpointerdown={scrubDown} onpointermove={scrubMove} onpointerup={scrubUp} onpointerleave={() => (hoverMs = null)}>
          <div class="progress"><i style:width="{duration ? (time / duration) * 100 : 0}%"></i></div>
          <div class="knob" style:left="{duration ? (time / duration) * 100 : 0}%"></div>
          {#if hoverMs !== null}<div class="tip" style:left="{hoverX}%">{P.clock(hoverMs)}</div>{/if}
        </div>
        <div class="times"><span>{P.clock(time)}</span><span>{duration ? `−${P.clock(duration - time)}` : ""}</span></div>
      {:else}
        <div class="times"><span class="livebadge">● LIVE</span><span></span></div>
      {/if}
      <div class="ctrls">
        <button class="ic big" data-tip={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause (Space)" : "Play (Space)"} onclick={togglePlay}>
          {#if playing}<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          {:else}<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z" /></svg>{/if}
        </button>
        {#if live}
          <button class="ic" data-tip="Previous channel (PgUp)" aria-label="Previous channel (PgUp)" onclick={() => go((index - 1 + request.items.length) % request.items.length)}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14l-10-7z" /></svg></button>
          <button class="ic" data-tip="Next channel (PgDn)" aria-label="Next channel (PgDn)" onclick={() => go((index + 1) % request.items.length)}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l10-7z" /></svg></button>
        {:else}
          <button class="ic" data-tip="Back 10s (←)" aria-label="Back 10s (←)" onclick={() => seekBy(-10_000)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4" /></svg></button>
          <button class="ic" data-tip="Forward 10s (→)" aria-label="Forward 10s (→)" onclick={() => seekBy(10_000)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v4h-4" /></svg></button>
          {#if hasNext}<button class="ic" data-tip="Next episode (N)" aria-label="Next episode (N)" onclick={() => go(index + 1, 0)}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5l9 7-9 7zM16 5h3v14h-3z" /></svg></button>{/if}
        {/if}
        <button class="ic" data-tip={muted ? "Unmute (M)" : "Mute (M)"} aria-label={muted ? "Unmute (M)" : "Mute (M)"} onclick={() => (muted = !muted)}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9h4l5-4v14l-5-4H4z" />{#if !muted && volume > 0}<path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2" />{:else}<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" />{/if}</svg>
        </button>
        <input class="vol" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} aria-label="Volume"
          oninput={(e) => { volume = Number((e.target as HTMLInputElement).value); muted = false; try { localStorage.setItem("telly.volume", String(volume)); } catch { /* ignore */ } }}
          style:--v="{(muted ? 0 : volume) * 100}%" />
        <div class="grow"></div>
        {#if !live}<button class="ic" data-tip="Speed" aria-label="Speed" onclick={() => (menu = menu === "speed" ? null : "speed")}>{speed === 1 ? "1×" : `${speed}×`}</button>{/if}
        <button class="ic" data-tip="Audio & subtitles" aria-label="Audio & subtitles" onclick={() => { readTracks(); menu = menu === "tracks" ? null : "tracks"; }}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v14H4zm2 9h5v2H6zm7 0h5v2h-5zm-7-3h12v2H6z" /></svg></button>
        <button class="ic" data-tip="Aspect ratio (A)" aria-label="Aspect ratio (A)" onclick={() => (menu = menu === "aspect" ? null : "aspect")}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z" /></svg></button>
        {#if vlc}<button class="ic" data-tip="Open in VLC" aria-label="Open in VLC" onclick={playInVlc}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 9H9zM8 13h8l1.5 4h-11zM4 19h16v3H4z" /></svg></button>{/if}
        <button class="ic" data-tip="Picture in picture (P)" aria-label="Picture in picture (P)" onclick={togglePip}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V5c0-1.1-.9-2-2-2H3C1.9 3 1 3.9 1 5v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 0H3V5h18v14z" /></svg></button>
        <button class="ic" data-tip="Full screen (F)" aria-label="Full screen (F)" onclick={toggleFullscreen}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg></button>
      </div>
    </div>
  </div>
</div>

<style>
  .player { position: fixed; inset: 0; z-index: 30; background: #000; cursor: none; overflow: hidden; }
  .player.awake { cursor: default; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transform-origin: center; transition: transform .2s; }
  .ui { opacity: 0; transition: opacity .25s; pointer-events: none; }
  .awake .ui { opacity: 1; pointer-events: auto; }
  .ov-top { position: absolute; left: 0; right: 0; top: 0; padding: 18px 34px 60px 90px; display: flex; gap: 16px; align-items: flex-start; background: linear-gradient(180deg, rgba(7,10,15,.8), transparent); }
  .back { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,.1); display: grid; place-items: center; cursor: pointer; font-size: 20px; border: 0; color: #fff; flex: none; -webkit-app-region: no-drag; }
  .back:hover { background: rgba(255,255,255,.2); }
  .t { font-size: 22px; font-weight: 600; } .s { color: var(--muted); }
  .ov-bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 70px 34px 22px; background: linear-gradient(0deg, rgba(7,10,15,.92), transparent); }
  .scrub { position: relative; height: 18px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
  .scrub .progress { flex: 1; height: 4px; transition: height .12s; }
  .scrub:hover .progress { height: 6px; }
  .knob { position: absolute; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #fff; box-shadow: 0 0 10px var(--glow); }
  .tip { position: absolute; bottom: 22px; transform: translateX(-50%); font-size: 12px; padding: 3px 8px; border-radius: 6px; background: rgba(10,14,20,.92); pointer-events: none; }
  .times { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin: 6px 0 10px; }
  .livebadge { color: #ff6b6f; font-weight: 700; letter-spacing: .04em; }
  .ctrls { display: flex; gap: 6px; align-items: center; }
  .ic { height: 38px; min-width: 38px; padding: 0 10px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 13px; position: relative; border: 0; background: none; color: #fff; }
  .ic:hover { background: rgba(255,255,255,.12); }
  .ic svg { width: 20px; height: 20px; }
  .ic.big svg { width: 26px; height: 26px; }
  .ic[data-tip]:hover::after { content: attr(data-tip); position: absolute; bottom: 44px; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 11.5px; padding: 3px 8px; border-radius: 6px; background: rgba(10,14,20,.92); color: var(--text); pointer-events: none; }
  .grow { flex: 1; }
  .vol { width: 90px; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--accent) var(--v), rgba(255,255,255,.2) var(--v)); cursor: pointer; }
  .vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
  .menu { position: absolute; right: 34px; bottom: 100px; width: 270px; max-height: calc(100% - 200px); overflow-y: auto; border-radius: 14px; padding: 12px; background: rgba(20,26,36,.96); border: 1px solid rgba(255,255,255,.08); display: flex; flex-direction: column; gap: 2px; box-shadow: 0 20px 50px rgba(0,0,0,.5); }
  .menu h4 { margin: 4px 8px 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .opt { min-height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; color: #d3dae3; cursor: pointer; border: 0; background: none; text-align: left; }
  .opt:hover { background: rgba(255,255,255,.08); }
  .opt.sel::after { content: "✓"; color: var(--accent); font-weight: 900; }
  .nextp { position: absolute; right: 34px; bottom: 124px; padding: 10px 34px 10px 14px; border-radius: 10px; font-size: 12.5px; background: rgba(16,20,24,.8); border: 1px solid var(--accent); cursor: pointer; color: var(--text); text-align: left; max-width: 340px; }
  .nextp b { display: block; }
  .nextp:hover { background: rgba(16,20,24,.95); }
  .nextp .x { position: absolute; top: 8px; right: 10px; color: var(--muted); }
  .player:not(.awake) .nextp { opacity: .9; pointer-events: auto; }
  .player:not(.awake) .ui:has(.nextp) { opacity: 1; }
  .player:not(.awake) .ui:has(.nextp) > :not(.nextp) { opacity: 0; }
  .adjust { position: absolute; left: 50%; top: 90px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 20px; border-radius: 14px; background: rgba(20,26,36,.92); border: 1px solid rgba(79,195,247,.4); text-align: center; }
  .toast { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); font-size: 22px; font-weight: 700; padding: 12px 22px; border-radius: 14px; background: rgba(10,14,20,.7); pointer-events: none; z-index: 2; }
  .failure { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 40px; z-index: 3; }
  .failure b { font-size: 20px; }
  .failure span { color: var(--muted); max-width: 520px; }
  .failure .btns { margin-top: 10px; justify-content: center; }
</style>
