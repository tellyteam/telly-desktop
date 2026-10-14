import type Hls from "hls.js";
import type Mpegts from "mpegts.js";
import { isWebKit, relayUrl, remuxUrl, type FilmProbe } from "./backend";
import { engineFor } from "./playback";

/**
 * Attaches a stream to a <video> element through the relay, with the right engine:
 * - HLS: natively on a Mac (Safari's engine also decodes Dolby audio), hls.js elsewhere.
 * - MPEG-TS (most live channels): mpegts.js.
 * - Files (mp4, mkv…): the video element itself. MKV doesn't play in Safari's engine,
 *   and the player offers VLC instead.
 */

export interface Track {
  id: number;
  label: string;
}

export interface Attached {
  destroy(): void;
  audioTracks(): Track[];
  audioTrack(): number;
  setAudioTrack(id: number): void;
  subtitleTracks(): Track[];
  subtitleTrack(): number;
  setSubtitleTrack(id: number): void;
}

export interface AttachOptions {
  live: boolean;
  /** Play the film repacked into MP4 by the relay, from this point and with this audio track. */
  remux?: { startSecs: number; audio?: number; probe: FilmProbe };
  /** Called once with a readable message when the stream can't be played. */
  onError: (message: string) => void;
  /** Tracks changed (e.g. once a manifest has loaded). */
  onTracks?: () => void;
}

const label = (name?: string, lang?: string, i = 0) => {
  const l = lang && lang !== "und" ? (() => {
    try {
      return new Intl.DisplayNames(undefined, { type: "language" }).of(lang);
    } catch {
      return lang;
    }
  })() : undefined;
  if (name && l && !name.toLowerCase().includes(l.toLowerCase())) return `${name} · ${l}`;
  return name || l || `Track ${i + 1}`;
};

/** Audio and text tracks the video element exposes itself (native HLS and files). */
function nativeTracks(video: HTMLVideoElement): Pick<Attached, "audioTracks" | "audioTrack" | "setAudioTrack" | "subtitleTracks" | "subtitleTrack" | "setSubtitleTrack"> {
  type AudioTrackList = { length: number; [i: number]: { label: string; language: string; enabled: boolean } };
  const audio = () => (video as unknown as { audioTracks?: AudioTrackList }).audioTracks;
  const texts = () => [...video.textTracks].filter((t) => t.kind === "subtitles" || t.kind === "captions");
  return {
    audioTracks: () => {
      const a = audio();
      return a ? Array.from({ length: a.length }, (_, i) => ({ id: i, label: label(a[i].label, a[i].language, i) })) : [];
    },
    audioTrack: () => {
      const a = audio();
      if (!a) return -1;
      for (let i = 0; i < a.length; i++) if (a[i].enabled) return i;
      return -1;
    },
    setAudioTrack: (id) => {
      const a = audio();
      if (a) for (let i = 0; i < a.length; i++) a[i].enabled = i === id;
    },
    subtitleTracks: () => texts().map((t, i) => ({ id: i, label: label(t.label, t.language, i) })),
    subtitleTrack: () => texts().findIndex((t) => t.mode === "showing"),
    setSubtitleTrack: (id) => texts().forEach((t, i) => (t.mode = i === id ? "showing" : "disabled")),
  };
}

export async function attach(video: HTMLVideoElement, url: string, opts: AttachOptions): Promise<Attached> {
  const engine = engineFor(url, opts.live);
  let failed = false;
  const fail = (msg: string) => {
    if (failed) return;
    failed = true;
    opts.onError(msg);
  };
  const src = opts.remux ? remuxUrl(url, opts.remux.startSecs, opts.remux.audio) : relayUrl(url, { hls: true });

  if (opts.remux) return attachRemux(video, src, opts.remux.probe, opts.remux.audio, opts, fail);

  if (engine === "hls" && !(isWebKit && video.canPlayType("application/vnd.apple.mpegurl"))) {
    const { default: HlsJs } = await import("hls.js");
    if (HlsJs.isSupported()) return attachHls(HlsJs, video, src, opts, fail);
  }

  if (engine === "mpegts") {
    const mpegts = (await import("mpegts.js")).default;
    if (mpegts.getFeatureList().mseLivePlayback) return attachMpegts(mpegts, video, src, opts, fail);
  }

  // Native: HLS on a Mac, or a plain file.
  const onError = () => {
    const code = video.error?.code;
    fail(code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
      ? "This video's format can't be played here."
      : "The stream stopped or couldn't be loaded.");
  };
  video.addEventListener("error", onError);
  // Subtitles start off even when the stream flags a track "default"; the player menu turns them on.
  const startOff = (e: TrackEvent) => {
    const t = e.track as TextTrack | null;
    if (t && (t.kind === "subtitles" || t.kind === "captions") && t.mode === "showing") t.mode = "disabled";
  };
  const tracksChanged = () => opts.onTracks?.();
  video.addEventListener("loadedmetadata", tracksChanged);
  video.textTracks.addEventListener?.("addtrack", startOff as EventListener);
  video.textTracks.addEventListener?.("addtrack", tracksChanged);
  video.src = src;
  return {
    ...nativeTracks(video),
    destroy() {
      video.removeEventListener("error", onError);
      video.removeEventListener("loadedmetadata", tracksChanged);
      video.textTracks.removeEventListener?.("addtrack", tracksChanged);
      video.textTracks.removeEventListener?.("addtrack", startOff as EventListener);
      video.removeAttribute("src");
      video.load();
    },
  };
}

// ---- Repacked films: fed to the player through Media Source Extensions ----

/** Audio the relay copies as it is (the same list as remux.rs); anything else arrives as AAC. */
const COPY_AUDIO: Record<string, string> = { aac: "mp4a.40.2", ac3: "ac-3", eac3: "ec-3", mp3: "mp4a.40.34", alac: "alac" };

/** The MSE type for a repacked film. The codec details don't need to be exact; the stream carries them. */
export function remuxMime(probe: FilmProbe, audio?: number): string {
  const codecs: string[] = [];
  const v = probe.video?.codec;
  if (v === "h264") codecs.push("avc1.640028");
  else if (v === "hevc") codecs.push("hvc1.2.4.L153.B0");
  else if (v === "av1") codecs.push("av01.0.08M.08");
  else if (v === "vp9") codecs.push("vp09.00.40.08");
  const track = (audio !== undefined ? probe.audio[audio] : undefined) ?? probe.audio.find((a) => a.default) ?? probe.audio[0];
  if (track) codecs.push(COPY_AUDIO[track.codec] ?? "mp4a.40.2");
  return `video/mp4; codecs="${codecs.join(", ")}"`;
}

/**
 * Safari's engine only plays MP4 from a server that answers byte ranges, which a stream being
 * converted can't. So, like hls.js, the stream is read here and appended to a MediaSource,
 * keeping about a minute ahead buffered (reading pauses beyond that, which also pauses FFmpeg).
 */
function attachRemux(
  video: HTMLVideoElement, src: string, probe: FilmProbe, audio: number | undefined, opts: AttachOptions, fail: (m: string) => void,
): Attached {
  const AHEAD_SECS = 60;
  const BEHIND_SECS = 30;
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  const abort = new AbortController();
  let stopped = false;

  const updated = (sb: SourceBuffer) => new Promise<void>((resolve, reject) => {
    sb.addEventListener("updateend", () => resolve(), { once: true });
    sb.addEventListener("error", () => reject(new Error("append")), { once: true });
  });
  const ahead = () => {
    const b = video.buffered;
    return b.length ? b.end(b.length - 1) - video.currentTime : 0;
  };
  async function trimBehind(sb: SourceBuffer) {
    const b = video.buffered;
    if (b.length && video.currentTime - b.start(0) > BEHIND_SECS + 10) {
      sb.remove(b.start(0), video.currentTime - BEHIND_SECS);
      await updated(sb);
    }
  }

  async function pump() {
    await new Promise<void>((r) => ms.addEventListener("sourceopen", () => r(), { once: true }));
    const mime = remuxMime(probe, audio);
    if (!MediaSource.isTypeSupported(mime)) return fail("This film's format can't be played on this Mac.");
    const sb = ms.addSourceBuffer(mime);
    if (probe.durationSecs) ms.duration = probe.durationSecs;
    let res: Response;
    try {
      res = await fetch(src, { signal: abort.signal });
    } catch {
      if (!stopped) fail("The film couldn't be loaded.");
      return;
    }
    if (!res.ok || !res.body) return fail(res.status === 502 ? await res.text() : "The film couldn't be loaded.");
    const reader = res.body.getReader();
    opts.onTracks?.();
    while (!stopped) {
      // Stay about a minute ahead; waiting here stops reading, and FFmpeg waits too.
      while (!stopped && ahead() > AHEAD_SECS) await new Promise((r) => setTimeout(r, 500));
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (stopped) break;
      if (done) {
        if (ms.readyState === "open" && !sb.updating) ms.endOfStream();
        break;
      }
      try {
        sb.appendBuffer(value!);
        await updated(sb);
        await trimBehind(sb);
      } catch (e) {
        if ((e as DOMException).name === "QuotaExceededError") {
          await trimBehind(sb).catch(() => {});
          continue;
        }
        return fail("This film's format can't be played on this Mac.");
      }
    }
  }

  video.src = objectUrl;
  pump().catch(() => { if (!stopped) fail("The film couldn't be loaded."); });
  return {
    ...nativeTracks(video),
    destroy() {
      stopped = true;
      abort.abort();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

function attachHls(HlsJs: typeof Hls, video: HTMLVideoElement, src: string, opts: AttachOptions, fail: (m: string) => void): Attached {
  // subtitleDisplay: false — a stream's "default" subtitle track doesn't switch subtitles on.
  const hls = new HlsJs({ enableWorker: true, backBufferLength: 60, maxBufferLength: 30, capLevelToPlayerSize: false, subtitleDisplay: false });
  let mediaRecoveries = 0;
  hls.on(HlsJs.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === HlsJs.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
      hls.recoverMediaError();
    } else if (data.type === HlsJs.ErrorTypes.NETWORK_ERROR) {
      const status = (data.response as { code?: number } | undefined)?.code;
      fail(status === 401 || status === 403 ? "The provider refused this stream. Your account may allow fewer connections." :
        status === 404 ? "The provider couldn't find this stream." : "The stream couldn't be loaded.");
    } else {
      fail("This stream's format can't be played here.");
    }
  });
  hls.on(HlsJs.Events.MANIFEST_PARSED, () => opts.onTracks?.());
  hls.on(HlsJs.Events.AUDIO_TRACKS_UPDATED, () => opts.onTracks?.());
  hls.on(HlsJs.Events.SUBTITLE_TRACKS_UPDATED, () => opts.onTracks?.());
  hls.loadSource(src);
  hls.attachMedia(video);
  return {
    destroy: () => hls.destroy(),
    audioTracks: () => hls.audioTracks.map((t, i) => ({ id: i, label: label(t.name, t.lang, i) })),
    audioTrack: () => hls.audioTrack,
    setAudioTrack: (id) => (hls.audioTrack = id),
    subtitleTracks: () => hls.subtitleTracks.map((t, i) => ({ id: i, label: label(t.name, t.lang, i) })),
    subtitleTrack: () => hls.subtitleTrack,
    setSubtitleTrack: (id) => {
      hls.subtitleTrack = id;
      hls.subtitleDisplay = id >= 0;
    },
  };
}

function attachMpegts(mpegts: typeof Mpegts, video: HTMLVideoElement, src: string, opts: AttachOptions, fail: (m: string) => void): Attached {
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: opts.live, url: src },
    { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: opts.live, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5, autoCleanupSourceBuffer: true },
  );
  player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
    if (type === mpegts.ErrorTypes.NETWORK_ERROR) fail("The stream couldn't be loaded.");
    else fail(detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED || detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED
      ? "This stream's format can't be played here." : "The stream stopped.");
  });
  player.attachMediaElement(video);
  player.load();
  return {
    ...nativeTracks(video),
    destroy() {
      try {
        player.pause();
        player.unload();
        player.detachMediaElement();
      } finally {
        player.destroy();
      }
    },
  };
}
