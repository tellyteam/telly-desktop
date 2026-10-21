import type Hls from "hls.js";
import type Mpegts from "mpegts.js";
import { isWebOS, relayUrl } from "./backend";
import { engineFor } from "./playback";

/**
 * Attaches a stream to a <video> element with the right engine:
 * - On an LG TV: the TV's own media pipeline, whenever it says it can play the type.
 * - HLS: hls.js otherwise (the Simulator, some older TVs, a browser during development).
 * - MPEG-TS (most live channels): mpegts.js otherwise.
 * - Files (mp4, mkv…): the video element itself.
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
  const src = relayUrl(url, { hls: true });

  // LG TVs play HLS, MPEG-TS, MKV and the rest in their own media pipeline, with hardware decoding;
  // where the TV says it can't (the Simulator, some older models), the players below take over.
  const nativeType = engine === "hls" ? "application/vnd.apple.mpegurl" : engine === "mpegts" ? "video/mp2t" : "";
  if (isWebOS && (!nativeType || video.canPlayType(nativeType))) return attachNative(video, src, opts, fail);

  if (engine === "hls") {
    const { default: HlsJs } = await import("hls.js");
    if (HlsJs.isSupported()) return attachHls(HlsJs, video, src, opts, fail);
  }

  if (engine === "mpegts") {
    const mpegts = (await import("mpegts.js")).default;
    if (mpegts.getFeatureList().mseLivePlayback) return attachMpegts(mpegts, video, src, opts, fail);
  }

  return attachNative(video, src, opts, fail);
}

/** The video element itself: a plain file, or anything an LG TV plays itself. */
function attachNative(video: HTMLVideoElement, src: string, opts: AttachOptions, fail: (msg: string) => void): Attached {
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

function attachHls(HlsJs: typeof Hls, video: HTMLVideoElement, src: string, opts: AttachOptions, fail: (m: string) => void): Attached {
  const hls = new HlsJs({ enableWorker: true, backBufferLength: 60, maxBufferLength: 30, capLevelToPlayerSize: false });
  // A stream's "default" subtitle track doesn't switch subtitles on; the player menu does.
  hls.subtitleDisplay = false;
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
