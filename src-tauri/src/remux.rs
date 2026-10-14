//! Playing films the Mac's video engine can't open (MKV, AVI…) by repacking them into MP4 as they
//! stream, with the bundled FFmpeg. Video is copied untouched; audio is copied when the Mac can
//! play it in MP4 and converted to AAC otherwise. Nothing is re-encoded that doesn't have to be, so
//! it costs very little CPU.
//!
//! FFmpeg reads the film through the relay itself (plain HTTP on 127.0.0.1), which keeps the
//! provider's HTTPS, redirects and the plain-HTTP setting in one place.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// What's inside a film, read from FFmpeg's description of its input.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// e.g. "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2", "avi".
    pub format: String,
    pub duration_secs: Option<f64>,
    pub video: Option<Stream>,
    pub audio: Vec<Stream>,
    pub subtitles: Vec<Stream>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    /// FFmpeg's input stream index (the N in 0:N).
    pub index: usize,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    /// Audio only: "stereo", "5.1(side)", "7.1"…
    pub layout: Option<String>,
    pub default: bool,
}

impl Probe {
    /// MP4 and MOV play directly (with seeking by byte range); everything else is repacked.
    pub fn needs_remux(&self) -> bool {
        !self.format.starts_with("mov,mp4")
    }

    /// Whether the Mac can decode the video at all; if not, repacking won't help.
    pub fn video_playable(&self) -> bool {
        self.video.as_ref().is_none_or(|v| PLAYABLE_VIDEO.contains(&v.codec.as_str()))
    }
}

/// Video the Mac's engine decodes from MP4 (AV1 needs an M3 or later; it fails cleanly elsewhere).
const PLAYABLE_VIDEO: &[&str] = &["h264", "hevc", "av1", "vp9", "mpeg4"];
/// Audio it plays straight from MP4; anything else is converted to AAC.
const COPY_AUDIO: &[&str] = &["aac", "ac3", "eac3", "mp3", "alac"];

/// Reads `ffmpeg -i` output. FFmpeg prints the input's description to stderr even though it then
/// stops with "At least one output file must be specified".
pub fn parse_probe(stderr: &str) -> Probe {
    let mut probe = Probe::default();
    let mut current: Option<(char, Stream)> = None;
    let flush = |probe: &mut Probe, current: &mut Option<(char, Stream)>| {
        if let Some((kind, s)) = current.take() {
            match kind {
                'v' if probe.video.is_none() => probe.video = Some(s),
                'a' => probe.audio.push(s),
                's' => probe.subtitles.push(s),
                _ => {}
            }
        }
    };
    for raw in stderr.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("Input #0, ") {
            probe.format = rest.split(", from ").next().unwrap_or("").to_string();
        } else if let Some(rest) = line.strip_prefix("Duration: ") {
            probe.duration_secs = parse_clock(rest.split(',').next().unwrap_or(""));
        } else if let Some(rest) = line.strip_prefix("Stream #0:") {
            flush(&mut probe, &mut current);
            current = parse_stream(rest);
        } else if let Some((key, value)) = line.split_once(':') {
            // "title           : Director's commentary", inside a stream's Metadata block.
            if key.trim() == "title" {
                if let Some((_, s)) = current.as_mut() {
                    s.title.get_or_insert_with(|| value.trim().to_string());
                }
            }
        }
    }
    flush(&mut probe, &mut current);
    probe
}

/// `1(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)`
fn parse_stream(rest: &str) -> Option<(char, Stream)> {
    let (head, body) = rest.split_once(": ")?;
    let index: usize = head.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()?;
    let language = head.split_once('(').and_then(|(_, l)| l.split(')').next()).map(str::to_string).filter(|l| l != "und");
    let (kind, details) = body.split_once(": ")?;
    let kind = match kind {
        "Video" => 'v',
        "Audio" => 'a',
        "Subtitle" => 's',
        _ => return None,
    };
    // Cover art inside the file shows up as a video stream.
    if kind == 'v' && details.contains("(attached pic)") {
        return None;
    }
    let codec: String = details.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    let layout = (kind == 'a').then(|| details.split(", ").nth(2).map(|l| l.trim().to_string())).flatten();
    Some((kind, Stream { index, codec, language, title: None, layout, default: details.contains("(default)") }))
}

fn parse_clock(text: &str) -> Option<f64> {
    let mut parts = text.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn channels(layout: Option<&str>) -> u32 {
    match layout.unwrap_or("") {
        l if l.starts_with("mono") => 1,
        l if l.starts_with("stereo") => 2,
        l if l.starts_with("7.1") => 8,
        l if l.starts_with("6.1") => 7,
        l if l.starts_with("5.1") || l.starts_with("5.0") => 6,
        _ => 2,
    }
}

/// FFmpeg's arguments to repack `input` into fragmented MP4 on stdout, starting `start_secs` in,
/// with the chosen audio track (an index into [Probe::audio]; the default track otherwise).
pub fn remux_args(probe: &Probe, input: &str, start_secs: f64, audio: Option<usize>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin"].map(String::from).to_vec();
    if start_secs > 0.0 {
        a.extend(["-ss".into(), format!("{start_secs:.3}")]);
    }
    a.extend(["-i".into(), input.to_string()]);
    if let Some(v) = &probe.video {
        a.extend(["-map".into(), format!("0:{}", v.index), "-c:v".into(), "copy".into()]);
        // Safari only plays HEVC in MP4 when it's tagged hvc1.
        if v.codec == "hevc" {
            a.extend(["-tag:v".into(), "hvc1".into()]);
        }
    }
    let chosen = audio
        .and_then(|i| probe.audio.get(i))
        .or_else(|| probe.audio.iter().find(|s| s.default))
        .or_else(|| probe.audio.first());
    if let Some(s) = chosen {
        a.extend(["-map".into(), format!("0:{}", s.index)]);
        if COPY_AUDIO.contains(&s.codec.as_str()) {
            a.extend(["-c:a".into(), "copy".into()]);
        } else {
            let ch = channels(s.layout.as_deref()).min(6);
            a.extend(["-c:a".into(), "aac".into(), "-ac".into(), ch.to_string(), "-b:a".into(), format!("{}k", if ch > 2 { 384 } else { 192 })]);
        }
    }
    // Subtitles stay out: the player is fed through Media Source Extensions, which take only
    // audio and video. (Text subtitles could follow later as a separate WebVTT track.)
    a.extend(
        ["-sn", "-dn", "-map_chapters", "-1", "-avoid_negative_ts", "make_zero", "-f", "mp4", "-movflags", "frag_keyframe+delay_moov+default_base_moof", "pipe:1"]
            .map(String::from),
    );
    a
}

// ---- Running FFmpeg ----

/// The bundled FFmpeg, next to telly's own executable (where Tauri puts sidecars).
pub fn ffmpeg() -> Option<&'static Path> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let p = std::env::current_exe().ok()?.parent()?.join("ffmpeg");
        p.is_file().then_some(p)
    })
    .as_deref()
}

/// Probes are cached per film for the session: seeking and switching audio re-use them.
pub fn probe(input_key: &str, input_url: &str) -> Result<Probe, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(p) = cache.lock().map_err(|_| "probe cache")?.get(input_key) {
        return Ok(p.clone());
    }
    let ffmpeg = ffmpeg().ok_or("FFmpeg isn't bundled with this build")?;
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i", input_url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // FFmpeg exits by itself once it has described the input; don't wait forever on a slow provider.
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("The provider took too long to answer".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut stderr = String::new();
    child.stderr.take().map(|mut e| e.read_to_string(&mut stderr));
    let probe = parse_probe(&stderr);
    if std::env::var_os("TELLY_RELAY_LOG").is_some() {
        let codecs = |l: &[Stream]| l.iter().map(|s| s.codec.as_str()).collect::<Vec<_>>().join(",");
        eprintln!(
            "probe: {} {:?}s video={:?} audio=[{}] subs=[{}]",
            probe.format, probe.duration_secs, probe.video.as_ref().map(|v| &v.codec), codecs(&probe.audio), codecs(&probe.subtitles)
        );
    }
    if probe.format.is_empty() {
        return Err("The film couldn't be opened".into());
    }
    cache.lock().map_err(|_| "probe cache")?.insert(input_key.to_string(), probe.clone());
    Ok(probe)
}

/// FFmpeg's output, which stops the process when dropped (the viewer closed or seeked).
pub struct Remux {
    child: Child,
    stdout: ChildStdout,
}

impl Read for Remux {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stdout.read(buf)
    }
}

impl Drop for Remux {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(mut current) = CURRENT.lock() {
            if *current == Some(self.child.id()) {
                *current = None;
            }
        }
    }
}

/// Only one film converts at a time: starting another (a seek, a new film) stops the last.
static CURRENT: Mutex<Option<u32>> = Mutex::new(None);

pub fn start(args: &[String]) -> Result<Remux, String> {
    let ffmpeg = ffmpeg().ok_or("FFmpeg isn't bundled with this build")?;
    if let Some(pid) = CURRENT.lock().map_err(|_| "remux lock")?.take() {
        // SIGTERM: FFmpeg stops cleanly, and the old response ends.
        let _ = Command::new("/bin/kill").arg(pid.to_string()).status();
    }
    let logging = std::env::var_os("TELLY_RELAY_LOG").is_some();
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if logging { Stdio::piped() } else { Stdio::null() })
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(stderr) = child.stderr.take() {
        // Troubleshooting only. The input address carries the login, so it's never written out.
        let input = args.iter().skip_while(|a| *a != "-i").nth(1).cloned().unwrap_or_default();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("ffmpeg: {}", line.replace(&input, "<film>"));
            }
        });
    }
    *CURRENT.lock().map_err(|_| "remux lock")? = Some(child.id());
    let stdout = child.stdout.take().ok_or("no output")?;
    Ok(Remux { child, stdout })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MKV: &str = r#"Input #0, matroska,webm, from 'http://127.0.0.1:5000/t/c/abc/1.mkv':
  Metadata:
    title           : Hit Man
  Duration: 01:55:07.52, start: 0.000000, bitrate: 6000 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr, 1k tbn (default)
  Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
      Metadata:
        title           : English DD+ 5.1
  Stream #0:2(eng): Audio: dts (DTS-HD MA), 48000 Hz, 7.1, s32p (24 bit)
  Stream #0:3(eng): Subtitle: subrip (default)
  Stream #0:4(eng): Subtitle: hdmv_pgs_subtitle (pgssub), 1920x1080
  Stream #0:5: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x900, 90k tbr, 90k tbn (attached pic)
At least one output file must be specified"#;

    #[test]
    fn reads_an_mkv_description() {
        let p = parse_probe(MKV);
        assert_eq!(p.format, "matroska,webm");
        assert_eq!(p.duration_secs, Some(6907.52));
        assert_eq!(p.video.as_ref().map(|v| (v.index, v.codec.as_str())), Some((0, "hevc")));
        assert_eq!(p.audio.len(), 2);
        assert_eq!(p.audio[0].codec, "eac3");
        assert_eq!(p.audio[0].language.as_deref(), Some("eng"));
        assert_eq!(p.audio[0].title.as_deref(), Some("English DD+ 5.1"));
        assert_eq!(p.audio[0].layout.as_deref(), Some("5.1(side)"));
        assert!(p.audio[0].default);
        assert_eq!(p.audio[1].codec, "dts");
        assert_eq!(p.subtitles.iter().map(|s| s.codec.as_str()).collect::<Vec<_>>(), ["subrip", "hdmv_pgs_subtitle"]);
        assert!(p.needs_remux());
        assert!(p.video_playable());
    }

    #[test]
    fn mp4_plays_directly() {
        let p = parse_probe("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':\n  Duration: 00:10:00.00, start: 0\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p\n");
        assert!(!p.needs_remux());
        assert_eq!(p.video.map(|v| v.codec), Some("h264".into()));
    }

    #[test]
    fn copies_what_the_mac_plays_and_converts_the_rest() {
        let p = parse_probe(MKV);
        let args = remux_args(&p, "http://in", 0.0, None).join(" ");
        assert!(args.contains("-map 0:0 -c:v copy -tag:v hvc1"), "{args}");
        assert!(args.contains("-map 0:1 -c:a copy"), "{args}");
        // Subtitles and cover art stay out of the stream.
        assert!(args.contains("-sn -dn"), "{args}");
        assert!(!args.contains("0:3") && !args.contains("0:4") && !args.contains("0:5"), "{args}");
        assert!(!args.contains("-ss"));

        let dts = remux_args(&p, "http://in", 754.5, Some(1)).join(" ");
        assert!(dts.contains("-ss 754.500 -i http://in"), "{dts}");
        assert!(dts.contains("-map 0:2 -c:a aac -ac 6 -b:a 384k"), "{dts}");
    }

    #[test]
    fn unplayable_video_is_reported() {
        let p = parse_probe("Input #0, avi, from 'x':\n  Stream #0:0: Video: msmpeg4v3 (DIV3 / 0x33564944), yuv420p\n");
        assert!(!p.video_playable());
    }
}
