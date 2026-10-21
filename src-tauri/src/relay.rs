//! The local stream relay.
//!
//! The web view can't read from IPTV providers directly: their servers send no CORS headers, and
//! most streams are plain `http://`. So every provider request (the catalogue API, artwork and the
//! video itself) goes through this small HTTP server on 127.0.0.1, which fetches it upstream and
//! adds the headers the web view needs. HLS playlists are rewritten so their segments come through
//! the relay too.
//!
//! URLs look like `http://127.0.0.1:{port}/{token}/{flags}/{base64url(target)}/{name}`:
//! - `token` is random per launch, so other software on the machine can't use the relay.
//! - `flags`: `c` allows plain HTTP (the provider setting), `h` rewrites HLS playlists, `f` marks
//!   FFmpeg reading a film (see [FILM_READ]), `s` a spliced MKV (see mkvseek; `?l=` is where the
//!   film resumes after its header). `-` is none.
//! - `name` is the target's file name, only there to make URLs readable; it's ignored.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::io::{Cursor, Read};
use std::sync::Arc;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use url::Url;

use crate::{mkvseek, remux};

/// HLS playlists are small; anything bigger is not a playlist.
const MAX_PLAYLIST_BYTES: u64 = 8 * 1024 * 1024;

pub struct Relay {
    /// `http://127.0.0.1:{port}/{token}`
    pub base: String,
}

struct Clients {
    /// Follows redirects to plain HTTP only when the provider setting allows it.
    strict: reqwest::blocking::Client,
    lenient: reqwest::blocking::Client,
    /// For FFmpeg reading films: a new connection each time, none kept idle. Providers often
    /// allow one connection per account (an idle one counts), and close idle ones themselves.
    film_strict: reqwest::blocking::Client,
    film_lenient: reqwest::blocking::Client,
}

pub fn start(user_agent: String) -> std::io::Result<Relay> {
    let server = Server::http("127.0.0.1:0").map_err(std::io::Error::other)?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or_default();
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}");

    let clients = Arc::new(Clients {
        strict: client(&user_agent, false, true),
        lenient: client(&user_agent, true, true),
        film_strict: client(&user_agent, false, false),
        film_lenient: client(&user_agent, true, false),
    });
    let server = Arc::new(server);
    let prefix = format!("/{token}/");
    let relay_base = base.clone();
    std::thread::Builder::new().name("relay".into()).spawn(move || {
        for request in server.incoming_requests() {
            let clients = clients.clone();
            let prefix = prefix.clone();
            let base = relay_base.clone();
            // One thread per request: a video stream can stay open for hours.
            let _ = std::thread::Builder::new().name("relay-req".into()).spawn(move || handle(request, &prefix, &base, &clients));
        }
    })?;
    Ok(Relay { base })
}

fn client(user_agent: &str, allow_cleartext: bool, pooled: bool) -> reqwest::blocking::Client {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if !allow_cleartext && attempt.url().scheme() == "http" {
            attempt.error("redirected to plain HTTP, which is turned off for this provider")
        } else {
            attempt.follow()
        }
    });
    reqwest::blocking::Client::builder()
        .user_agent(user_agent)
        .redirect(policy)
        .pool_max_idle_per_host(if pooled { usize::MAX } else { 0 })
        .connect_timeout(Duration::from_secs(15))
        // No overall timeout: a live stream is one long response.
        .timeout(None)
        .build()
        .expect("HTTP client")
}

fn random_token() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut bytes = [0u8; 16];
    aes_gcm::aead::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parsed from a relay path (everything after the token).
#[derive(Debug, PartialEq)]
pub struct Target {
    pub url: Url,
    pub allow_cleartext: bool,
    pub rewrite_hls: bool,
}

pub fn parse_path(rest: &str) -> Option<Target> {
    let mut parts = rest.splitn(3, '/');
    let flags = parts.next()?;
    let encoded = parts.next()?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')).ok()?;
    let url = Url::parse(std::str::from_utf8(&bytes).ok()?).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(Target { url, allow_cleartext: flags.contains('c'), rewrite_hls: flags.contains('h') })
}

/// The relay URL for [target], keeping the same flags.
pub fn wrap(base: &str, flags: &str, target: &Url) -> String {
    let name = target.path_segments().and_then(|mut s| s.next_back()).filter(|s| !s.is_empty()).unwrap_or("x");
    let name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(60).collect();
    format!("{base}/{flags}/{}/{}", URL_SAFE_NO_PAD.encode(target.as_str()), if name.is_empty() { "x" } else { &name })
}

/// Points every URI in an HLS playlist (segments, variant playlists, keys, media renditions) at the relay.
pub fn rewrite_playlist(text: &str, playlist_url: &Url, wrap_url: &dyn Fn(&Url) -> String) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push_str(line);
        } else if trimmed.starts_with('#') {
            out.push_str(&rewrite_uri_attributes(trimmed, playlist_url, wrap_url));
        } else {
            match playlist_url.join(trimmed) {
                Ok(u) => out.push_str(&wrap_url(&u)),
                Err(_) => out.push_str(trimmed),
            }
        }
        out.push('\n');
    }
    out
}

fn rewrite_uri_attributes(tag: &str, base: &Url, wrap_url: &dyn Fn(&Url) -> String) -> String {
    const KEY: &str = "URI=\"";
    let mut out = String::with_capacity(tag.len());
    let mut rest = tag;
    while let Some(start) = rest.find(KEY) {
        let (head, tail) = rest.split_at(start + KEY.len());
        out.push_str(head);
        match tail.find('"') {
            Some(end) => {
                let value = &tail[..end];
                match base.join(value) {
                    Ok(u) if !value.starts_with("data:") => out.push_str(&wrap_url(&u)),
                    _ => out.push_str(value),
                }
                rest = &tail[end..];
            }
            None => {
                rest = tail;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn header(name: &str, value: &str) -> Option<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

fn cors_headers() -> Vec<Header> {
    [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "Range"),
        ("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type"),
    ]
    .iter()
    .filter_map(|(k, v)| header(k, v))
    .collect()
}

fn error(request: Request, status: u16, message: &str) {
    let mut response = Response::from_string(message).with_status_code(status);
    for h in cors_headers() {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn handle(request: Request, prefix: &str, base: &str, clients: &Clients) {
    let path = request.url().to_string();
    let Some(rest) = path.strip_prefix(prefix) else {
        return error(request, 404, "Not found");
    };
    if *request.method() == Method::Options {
        let mut response = Response::empty(204);
        for h in cors_headers() {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }
    let Some(target) = parse_path(rest) else {
        return error(request, 400, "Bad relay address");
    };
    if target.url.scheme() == "http" && !target.allow_cleartext {
        return error(request, 403, "Plain HTTP is turned off for this provider");
    }
    let flags = rest.split('/').next().unwrap_or("-");
    if flags.contains('p') || flags.contains('m') {
        return film(request, base, flags, &target, &path, clients);
    }

    let client = match (flags.contains('f'), target.allow_cleartext) {
        (false, false) => &clients.strict,
        (false, true) => &clients.lenient,
        (true, false) => &clients.film_strict,
        (true, true) => &clients.film_lenient,
    };
    let range = request.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    if flags.contains('s') {
        return spliced(request, &target, client, &path, range.as_deref(), flags.contains('f'));
    }
    let trace = Trace::begin(range.as_deref());
    // FFmpeg reading a film: a newer read (a skip, another film) replaces this one.
    let film_read = flags.contains('f').then(new_film_read);
    let send = |range: Option<&str>| get(client, &target.url, range);
    let response = match send(range.as_deref()) {
        Ok(r) => r,
        Err(e) => return failed(request, &target.url, &trace, &e),
    };

    let status = response.status().as_u16();
    let final_url = response.url().clone();
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if std::env::var_os("TELLY_RELAY_LOG").is_some() {
        // Troubleshooting only, and never the URL: Xtream URLs carry the login.
        let ext = final_url.path().rsplit('/').next().and_then(|f| f.rsplit_once('.')).map(|(_, e)| e).unwrap_or("-");
        eprintln!(
            "relay: #{} .{ext} {status} {content_type} len={:?} range={} answered in {}ms",
            trace.id,
            response.content_length(),
            range.as_deref().unwrap_or("-"),
            trace.started.elapsed().as_millis()
        );
    }
    let looks_like_playlist = content_type.to_ascii_lowercase().contains("mpegurl")
        || final_url.path().to_ascii_lowercase().ends_with(".m3u8");

    let mut headers = cors_headers();
    if target.rewrite_hls && looks_like_playlist && response.status().is_success() {
        // A playlist is rewritten whole, so a byte range from the player can't apply to it.
        let response = if status == 206 {
            match send(None) {
                Ok(r) => r,
                Err(_) => return error(request, 502, "The playlist couldn't be read"),
            }
        } else {
            response
        };
        let mut body = String::new();
        if response.take(MAX_PLAYLIST_BYTES).read_to_string(&mut body).is_err() {
            return error(request, 502, "The playlist couldn't be read");
        }
        let flags = rest.split('/').next().unwrap_or("-");
        let text = rewrite_playlist(&body, &final_url, &|u| wrap(base, flags, u));
        headers.extend(header("Content-Type", "application/vnd.apple.mpegurl"));
        headers.extend(header("Cache-Control", "no-store"));
        let len = text.len();
        let _ = request.respond(Response::new(StatusCode(200), headers, Cursor::new(text.into_bytes()), Some(len), None));
        return;
    }

    for name in ["content-type", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"] {
        if let Some(v) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            headers.extend(header(name, v));
        }
    }
    let length = response.content_length().map(|l| l as usize);
    let _ = request.respond(Response::new(StatusCode(status), headers, Traced { inner: response, trace, film_read }, length, None));
}

/// A GET to the provider, optionally for a byte range.
fn get(client: &reqwest::blocking::Client, url: &Url, range: Option<&str>) -> reqwest::Result<reqwest::blocking::Response> {
    let attempt = || {
        let mut upstream = client.get(url.clone());
        if let Some(r) = range {
            upstream = upstream.header("Range", r);
        }
        upstream.send()
    };
    // A kept-alive connection the provider has since closed fails at once: try again on a new one.
    attempt().or_else(|e| if e.is_redirect() || e.is_connect() || e.is_timeout() { Err(e) } else { attempt() })
}

/// Answers a failed provider request. Never with the URL: Xtream URLs carry the login.
fn failed(request: Request, url: &Url, trace: &Trace, e: &reqwest::Error) {
    if trace.logging {
        eprintln!("relay! #{} failed: {:?}", trace.id, std::error::Error::source(e).map(|s| s.to_string()));
    }
    let host = url.host_str().unwrap_or("the provider");
    let reason = if e.is_redirect() { "redirected to plain HTTP, which is turned off" } else if e.is_connect() { "couldn't connect" } else { "didn't answer" };
    error(request, 502, &format!("{host} {reason}"));
}

/// Part of a film, for mkvseek: `len` bytes from `at`, and the film's size.
fn fetch_part(client: &reqwest::blocking::Client, url: &Url, at: u64, len: u64) -> Result<(Vec<u8>, u64), String> {
    let response = get(client, url, Some(&format!("bytes={at}-{}", at + len.max(1) - 1))).map_err(|_| "The provider didn't answer")?;
    if response.status().as_u16() != 206 {
        return Err("The provider doesn't send parts of films".into());
    }
    let size = response
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next()?.parse::<u64>().ok())
        .ok_or("The provider didn't say the film's size")?;
    let mut bytes = Vec::with_capacity(len as usize);
    response.take(len).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok((bytes, size))
}

/// `bytes=a-b`, `bytes=a-` or nothing, as an inclusive range within `total`.
fn parse_range(range: Option<&str>, total: u64) -> (u64, u64) {
    let last = total.saturating_sub(1);
    let Some((a, b)) = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')) else { return (0, last) };
    let from = a.trim().parse().unwrap_or(0);
    (from, b.trim().parse::<u64>().map_or(last, |b| b.min(last)))
}

/// A spliced MKV (see mkvseek): the film's header from memory, then the film from `?l=` on, as one
/// file FFmpeg can read with byte ranges.
fn spliced(request: Request, target: &Target, client: &reqwest::blocking::Client, path: &str, range: Option<&str>, film: bool) {
    let resume = path.split_once("?l=").and_then(|(_, l)| l.parse::<u64>().ok());
    let mkv = mkvseek::header(target.url.as_str(), &|at, len| fetch_part(client, &target.url, at, len));
    let (Some(resume), Ok(mkv)) = (resume, mkv) else {
        return error(request, 502, "The film couldn't be read");
    };
    let head = mkv.bytes.len() as u64;
    let total = head + mkv.size.saturating_sub(resume);
    let (from, to) = parse_range(range, total);
    if from > to {
        return error(request, 416, "Past the end of the film");
    }
    let part = if from < head { mkv.bytes[from as usize..(to + 1).min(head) as usize].to_vec() } else { Vec::new() };
    let rest = (to >= head).then(|| format!("bytes={}-{}", resume + from.max(head) - head, resume + to - head));
    let trace = Trace::begin(rest.as_deref());
    let film_read = film.then(new_film_read);
    let upstream: Box<dyn Read + Send> = match rest {
        Some(r) => match get(client, &target.url, Some(&r)) {
            Ok(response) if response.status().as_u16() == 206 => Box::new(Traced { inner: response, trace, film_read }),
            Ok(_) => return error(request, 502, "The provider doesn't send parts of films"),
            Err(e) => return failed(request, &target.url, &trace, &e),
        },
        None => Box::new(std::io::empty()),
    };
    let mut headers = cors_headers();
    headers.extend(header("Content-Type", "video/x-matroska"));
    headers.extend(header("Accept-Ranges", "bytes"));
    headers.extend(header("Content-Range", &format!("bytes {from}-{to}/{total}")));
    let status = if range.is_some() { 206 } else { 200 };
    let body = Cursor::new(part).chain(upstream);
    let _ = request.respond(Response::new(StatusCode(status), headers, body, Some((to - from + 1) as usize), None));
}

/// Where to splice an MKV for FFmpeg to start at `start` secs (see mkvseek).
fn splice_at(client: &reqwest::blocking::Client, url: &Url, duration: Option<f64>, start: f64) -> Result<u64, String> {
    let fetch = |at, len| fetch_part(client, url, at, len);
    let header = mkvseek::header(url.as_str(), &fetch)?;
    let at = mkvseek::landing(&header, duration, start, &fetch)?;
    if at > header.bytes.len() as u64 { Ok(at) } else { Err("the time is at the start".into()) }
}

/// Starts a film read, ending any older one (see [FILM_READ]).
fn new_film_read() -> usize {
    FILM_READ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// Troubleshooting (TELLY_RELAY_LOG): when each provider request starts, is answered and ends,
/// and how many are open at once. Never the address.
struct Trace {
    id: usize,
    started: std::time::Instant,
    bytes: u64,
    logging: bool,
}

static OPEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static NEXT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);

impl Trace {
    fn begin(range: Option<&str>) -> Trace {
        use std::sync::atomic::Ordering::Relaxed;
        let logging = std::env::var_os("TELLY_RELAY_LOG").is_some();
        let id = NEXT_ID.fetch_add(1, Relaxed);
        let open = OPEN.fetch_add(1, Relaxed) + 1;
        if logging {
            eprintln!("relay> #{id} asking range={} ({open} open)", range.unwrap_or("-"));
        }
        Trace { id, started: std::time::Instant::now(), bytes: 0, logging }
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        let open = OPEN.fetch_sub(1, std::sync::atomic::Ordering::Relaxed) - 1;
        if self.logging {
            let secs = self.started.elapsed().as_secs_f64();
            eprintln!(
                "relay< #{} closed after {secs:.1}s, {:.1} MB at {:.1} Mbit/s ({open} open)",
                self.id,
                self.bytes as f64 / 1e6,
                self.bytes as f64 * 8.0 / 1e6 / secs.max(0.001)
            );
        }
    }
}

/// The latest film read by FFmpeg. Providers often allow one connection per account, and FFmpeg
/// opens its next read before closing the last (and a stopped FFmpeg can take a moment to go), so
/// an older read could block the new one: older reads end as soon as a newer one starts.
static FILM_READ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A provider response that counts what passes through it, and ends early if it's a film read
/// that a newer one has replaced.
struct Traced<R> {
    inner: R,
    trace: Trace,
    film_read: Option<usize>,
}

impl<R: Read> Read for Traced<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.film_read.is_some_and(|n| n != FILM_READ.load(std::sync::atomic::Ordering::SeqCst)) {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "replaced by a newer film read"));
        }
        let n = self.inner.read(buf)?;
        self.trace.bytes += n as u64;
        Ok(n)
    }
}

/// `p`: what's inside a film, as JSON. `m`: the film repacked into MP4 (`?t=` seconds to start
/// at, `?a=` audio track). FFmpeg reads the film back through this relay.
fn film(request: Request, base: &str, flags: &str, target: &Target, path: &str, clients: &Clients) {
    // A film is opening, or restarting at a new time: whatever was converting before is done.
    remux::stop();
    let read_flags = if target.allow_cleartext { "cf" } else { "f" };
    let input = wrap(base, read_flags, &target.url);
    let probe = match remux::probe(target.url.as_str(), &input) {
        Ok(p) => p,
        Err(e) => return error(request, 502, &e),
    };
    if flags.contains('p') {
        let mut json = serde_json::to_value(&probe).unwrap_or_default();
        json["needsRemux"] = probe.needs_remux().into();
        json["videoPlayable"] = probe.video_playable().into();
        let body = json.to_string();
        let mut response = Response::from_string(body);
        for h in cors_headers().into_iter().chain(header("Content-Type", "application/json")) {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('='));
    let start = param("t").and_then(|v| v.parse::<f64>().ok()).filter(|t| t.is_finite() && *t > 0.0).unwrap_or(0.0);
    let audio = param("a").and_then(|v| v.parse::<usize>().ok());
    // Skipping into an MKV: start FFmpeg's read near the time, instead of letting it read the film
    // from the start to get there (see mkvseek). Anything unexpected falls back to that.
    let client = if target.allow_cleartext { &clients.film_lenient } else { &clients.film_strict };
    let splice = if start > 0.0 && probe.format.starts_with("matroska") {
        splice_at(client, &target.url, probe.duration_secs, start)
            .inspect_err(|e| if std::env::var_os("TELLY_RELAY_LOG").is_some() { eprintln!("film: not spliced: {e}") })
            .ok()
    } else {
        None
    };
    if std::env::var_os("TELLY_RELAY_LOG").is_some() {
        eprintln!("film: start={start:.1}s spliced at {splice:?}");
    }
    let input = match splice {
        Some(at) => format!("{}?l={at}", wrap(base, &format!("{read_flags}s"), &target.url)),
        None => input,
    };
    match remux::start(&remux::remux_args(&probe, &input, start, audio, splice.is_some())) {
        Ok(output) => {
            let mut headers = cors_headers();
            headers.extend(header("Content-Type", "video/mp4"));
            headers.extend(header("Cache-Control", "no-store"));
            // No length and no byte ranges: seeking restarts the conversion at a new ?t=.
            let _ = request.respond(Response::new(StatusCode(200), headers, output, None, None));
        }
        Err(e) => error(request, 502, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay(u: &Url) -> String {
        format!("R[{u}]")
    }

    #[test]
    fn round_trips_a_target() {
        let url = Url::parse("http://example.com:8080/live/u/p/1.m3u8?x=1").unwrap();
        let wrapped = wrap("http://127.0.0.1:1/t", "ch", &url);
        assert!(wrapped.ends_with("/1.m3u8"));
        let rest = wrapped.strip_prefix("http://127.0.0.1:1/t/").unwrap();
        assert_eq!(parse_path(rest), Some(Target { url, allow_cleartext: true, rewrite_hls: true }));
    }

    #[test]
    fn refuses_other_schemes_and_junk() {
        let file = URL_SAFE_NO_PAD.encode("file:///etc/passwd");
        assert_eq!(parse_path(&format!("c/{file}/x")), None);
        assert_eq!(parse_path("c/!!!/x"), None);
        assert_eq!(parse_path(""), None);
    }

    #[test]
    fn rewrites_segments_variants_and_keys() {
        let base = Url::parse("http://cdn.example/hls/abc/index.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXTINF:6.0,\nseg1.ts\n\n#EXTINF:6.0,\n/root/seg2.ts\nhttps://other.example/seg3.ts\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/en.m3u8\",NAME=\"English\"\n";
        let out = rewrite_playlist(text, &base, &relay);
        assert_eq!(
            out,
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"R[http://cdn.example/hls/abc/key.bin]\",IV=0x1\n#EXTINF:6.0,\nR[http://cdn.example/hls/abc/seg1.ts]\n\n#EXTINF:6.0,\nR[http://cdn.example/root/seg2.ts]\nR[https://other.example/seg3.ts]\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"R[http://cdn.example/hls/abc/audio/en.m3u8]\",NAME=\"English\"\n"
        );
    }

    #[test]
    fn leaves_tags_without_uris_alone() {
        let base = Url::parse("http://a/b.m3u8").unwrap();
        assert_eq!(rewrite_playlist("#EXT-X-VERSION:3\n#EXT-X-ENDLIST", &base, &relay), "#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n");
    }
}

#[cfg(test)]
mod seek_check {
    use super::*;
    /// Manual check: FFmpeg skipping into the middle of an MKV through the relay, as telly does.
    /// FILM_URL is a range server (try one that allows a single connection, like many providers);
    /// FFMPEG is the bundled FFmpeg.
    #[test]
    #[ignore]
    fn ffmpeg_seeks_through_the_relay() {
        let relay = start("telly-test".into()).unwrap();
        let url = Url::parse(&std::env::var("FILM_URL").unwrap_or("http://127.0.0.1:8801/big.mkv".into())).unwrap();
        let input = wrap(&relay.base, "cf", &url);
        let t = std::time::Instant::now();
        let mut child = std::process::Command::new(std::env::var("FFMPEG").unwrap())
            .args(["-hide_banner", "-loglevel", "error", "-ss", "600", "-i", &input, "-map", "0:v:0", "-c", "copy", "-frames:v", "10", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let finished = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status.success();
            }
            if t.elapsed() > Duration::from_secs(40) {
                let _ = child.kill();
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        eprintln!("SEEK finished={finished} in {:?}", t.elapsed());
        assert!(finished, "FFmpeg didn't get to the middle of the film within 40 s");
    }

    /// Manual check: the player's request for a film from ten minutes in, start to first video.
    /// Needs FFmpeg next to the test binary (target/release/deps/ffmpeg); writes it to OUT.
    #[test]
    #[ignore]
    fn film_from_ten_minutes_in() {
        let relay = start("telly-test".into()).unwrap();
        let url = Url::parse(&std::env::var("FILM_URL").unwrap()).unwrap();
        let t = std::time::Instant::now();
        let mut response = reqwest::blocking::get(format!("{}?t=600", wrap(&relay.base, "cm", &url))).unwrap();
        let mut out = vec![0u8; 3_000_000];
        response.read_exact(&mut out).unwrap();
        eprintln!("FILM first 3 MB after {:?}", t.elapsed());
        std::fs::write(std::env::var("OUT").unwrap(), out).unwrap();
    }
}
