//! Skipping into MKV films that have no index (no Cues), which many providers' films don't.
//!
//! Without an index FFmpeg finds a time by reading the film from the start, so skipping an hour in
//! means downloading most of it first. Instead telly finds the place itself: it reads a little of
//! the film where the time should be, finds a cluster (a block of a few seconds of the film, which
//! starts with its own time) and homes in with a few more small reads. FFmpeg is then given a
//! spliced film: the original header (everything before the first cluster, with the parts that
//! point at byte positions blanked), followed by the film from that cluster on. FFmpeg only has to
//! read a few seconds to reach the exact time.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const EBML: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const CUES: u32 = 0x1C53_BB6B;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const CLUSTER: u32 = 0x1F43_B675;
const CLUSTER_TIMESTAMP: u32 = 0xE7;
const VOID: u8 = 0xEC;
const CRC32: u8 = 0xBF;

/// How much of the film to read when looking for a cluster.
const PROBE_BYTES: u64 = 1024 * 1024;
/// Header reads stop here: anything bigger isn't an ordinary film header.
const MAX_HEADER: u64 = 64 * 1024 * 1024;
/// Land this far before the asked time, so a keyframe before it is included.
const LEAD_SECS: f64 = 20.0;
/// Close enough: FFmpeg reads at most this much of the film to reach the time.
const WINDOW_SECS: f64 = 90.0;

/// The film's header, ready to put in front of a later part of the film.
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    /// Everything before the first cluster, with byte positions blanked (see [rewrite]).
    pub bytes: Vec<u8>,
    /// The film's size.
    pub size: u64,
    /// Nanoseconds per unit of a cluster's time.
    pub timestamp_scale: u64,
}

/// An EBML element ID (1–4 bytes, the length marker kept as part of the ID).
fn read_id(buf: &[u8], at: usize) -> Option<(u32, usize)> {
    let first = *buf.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 4 || at + len > buf.len() {
        return None;
    }
    Some((buf[at..at + len].iter().fold(0u32, |v, b| v << 8 | *b as u32), len))
}

/// An EBML size: the value (None when "unknown") and how many bytes it took.
fn read_size(buf: &[u8], at: usize) -> Option<(Option<u64>, usize)> {
    let first = *buf.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || at + len > buf.len() {
        return None;
    }
    let mut value = (first as u64) & (0xFF >> len);
    for b in &buf[at + 1..at + len] {
        value = value << 8 | *b as u64;
    }
    let unknown = value == (1u64 << (7 * len)) - 1;
    Some((if unknown { None } else { Some(value) }, len))
}

fn read_uint(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |v, b| v << 8 | *b as u64)
}

/// Replaces `buf[at..at + len]` with a Void element of the same length (len ≥ 9).
fn blank(buf: &mut [u8], at: usize, len: usize) {
    buf[at] = VOID;
    buf[at + 1] = 0x01;
    let size = (len - 9) as u64;
    buf[at + 2..at + 9].copy_from_slice(&size.to_be_bytes()[1..]);
    buf[at + 9..at + len].fill(0);
}

/// What [scan_header] finds in the start of a film.
#[derive(Debug, PartialEq)]
enum Scan {
    /// The first cluster starts at this offset.
    Clusters { at: u64, timestamp_scale: u64 },
    /// More of the film is needed to get past the header.
    NeedMore,
    NotMkv,
}

fn scan_header(buf: &[u8]) -> Scan {
    let Some((EBML, id_len)) = read_id(buf, 0) else { return Scan::NotMkv };
    let Some((Some(ebml_size), size_len)) = read_size(buf, id_len) else { return Scan::NotMkv };
    let mut at = id_len + size_len + ebml_size as usize;
    let Some((SEGMENT, id_len)) = read_id(buf, at) else { return Scan::NotMkv };
    let Some((_, size_len)) = read_size(buf, at + id_len) else { return Scan::NeedMore };
    at += id_len + size_len;
    let mut timestamp_scale = 1_000_000;
    loop {
        let Some((id, id_len)) = read_id(buf, at) else { return if at >= buf.len() { Scan::NeedMore } else { Scan::NotMkv } };
        if id == CLUSTER {
            return Scan::Clusters { at: at as u64, timestamp_scale };
        }
        let Some((Some(size), size_len)) = read_size(buf, at + id_len) else { return Scan::NeedMore };
        let body = at + id_len + size_len;
        let end = body + size as usize;
        if end > buf.len() {
            return Scan::NeedMore;
        }
        if id == INFO {
            let mut i = body;
            while let (Some((child, child_id_len)), true) = (read_id(buf, i), i < end) {
                let Some((Some(child_size), child_size_len)) = read_size(buf, i + child_id_len) else { break };
                let value_at = i + child_id_len + child_size_len;
                if child == TIMESTAMP_SCALE && value_at + child_size as usize <= end {
                    timestamp_scale = read_uint(&buf[value_at..value_at + child_size as usize]).max(1);
                }
                i = value_at + child_size as usize;
            }
        }
        at = end;
    }
}

/// The header bytes FFmpeg is given: the Segment's size becomes "unknown" (the spliced film is
/// shorter), and the SeekHead and any Cues before the clusters are blanked, since they point at
/// byte positions that no longer hold.
fn rewrite(mut head: Vec<u8>) -> Vec<u8> {
    let (_, id_len) = read_id(&head, 0).expect("checked by scan_header");
    let (ebml_size, size_len) = read_size(&head, id_len).expect("checked by scan_header");
    let segment = id_len + size_len + ebml_size.unwrap_or(0) as usize;
    let (_, seg_id_len) = read_id(&head, segment).expect("checked by scan_header");
    let (_, seg_size_len) = read_size(&head, segment + seg_id_len).expect("checked by scan_header");
    let size_at = segment + seg_id_len;
    head[size_at] = (1u16 << (8 - seg_size_len)) as u8 | ((1u16 << (8 - seg_size_len)) - 1) as u8;
    head[size_at + 1..size_at + seg_size_len].fill(0xFF);
    let mut at = size_at + seg_size_len;
    while let Some((id, id_len)) = read_id(&head, at) {
        let Some((Some(size), size_len)) = read_size(&head, at + id_len) else { break };
        let len = id_len + size_len + size as usize;
        if at + len > head.len() {
            break;
        }
        if (id == SEEK_HEAD || id == CUES) && len >= 9 {
            blank(&mut head, at, len);
        }
        at += len;
    }
    head
}

/// The first cluster in `buf` that looks real, and its time in the film's units.
fn find_cluster(buf: &[u8]) -> Option<(usize, u64)> {
    let id = CLUSTER.to_be_bytes();
    let mut from = 0;
    while let Some(i) = buf[from..].windows(4).position(|w| w == id).map(|i| i + from) {
        from = i + 1;
        // A cluster's first child is its time: check it's there, so data that happens to contain
        // the ID isn't taken for a cluster.
        let Some((_, size_len)) = read_size(buf, i + 4) else { continue };
        let mut child = i + 4 + size_len;
        // FFmpeg-made films put a checksum (CRC-32: BF 84 and four bytes) first.
        if buf.get(child..child + 2) == Some(&[CRC32, 0x84]) {
            child += 6;
        }
        if buf.get(child) != Some(&(CLUSTER_TIMESTAMP as u8)) {
            continue;
        }
        let Some((Some(len @ 1..=8), len_len)) = read_size(buf, child + 1) else { continue };
        let value = child + 1 + len_len;
        if value + len as usize > buf.len() {
            continue;
        }
        return Some((i, read_uint(&buf[value..value + len as usize])));
    }
    None
}

/// Reads part of the film: `(offset, length)` → the bytes, and the film's total size.
pub type Fetch<'a> = dyn Fn(u64, u64) -> Result<(Vec<u8>, u64), String> + 'a;

/// The film's header, read once per film for the session.
pub fn header(key: &str, fetch: &Fetch) -> Result<Header, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Header>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(h) = cache.lock().map_err(|_| "header cache")?.get(key) {
        return Ok(h.clone());
    }
    let (mut buf, size) = fetch(0, PROBE_BYTES)?;
    let header = loop {
        match scan_header(&buf) {
            Scan::Clusters { at, timestamp_scale } => {
                buf.truncate(at as usize);
                break Header { bytes: rewrite(buf), size, timestamp_scale };
            }
            Scan::NotMkv => return Err("not an MKV film".into()),
            Scan::NeedMore if (buf.len() as u64) < MAX_HEADER.min(size) => {
                let (more, _) = fetch(buf.len() as u64, (buf.len() as u64).min(MAX_HEADER - buf.len() as u64).max(PROBE_BYTES))?;
                if more.is_empty() {
                    return Err("the film ended inside its header".into());
                }
                buf.extend(more);
            }
            Scan::NeedMore => return Err("the film's header is too big".into()),
        }
    };
    cache.lock().map_err(|_| "header cache")?.insert(key.to_string(), header.clone());
    Ok(header)
}

/// The film's length from its last cluster, for films whose header doesn't say.
fn duration_from_end(header: &Header, fetch: &Fetch) -> Result<f64, String> {
    let from = header.size.saturating_sub(PROBE_BYTES * 4).max(header.bytes.len() as u64);
    let (buf, _) = fetch(from, header.size - from)?;
    let mut last = None;
    let mut at = 0;
    while let Some((i, units)) = find_cluster(&buf[at..]) {
        last = Some(units);
        at += i + 1;
    }
    last.map(|units| units as f64 * header.timestamp_scale as f64 / 1e9).ok_or_else(|| "no cluster near the end".into())
}

/// Where to splice the film to start near `target_secs`: a cluster's offset a little before it.
pub fn landing(header: &Header, duration_secs: Option<f64>, target_secs: f64, fetch: &Fetch) -> Result<u64, String> {
    let duration_secs = match duration_secs {
        Some(d) => d,
        None => duration_from_end(header, fetch)?,
    };
    let start = header.bytes.len() as u64;
    let span = header.size.saturating_sub(start) as f64;
    let secs_per_unit = header.timestamp_scale as f64 / 1e9;
    let aim = (target_secs - LEAD_SECS).max(0.0);
    // Bytes per second of film, refined by what each read finds.
    let mut rate = span / duration_secs.max(1.0);
    let mut guess = start + (aim * rate) as u64;
    let mut best: Option<(u64, f64)> = None;
    let mut last = None;
    for _ in 0..8 {
        guess = guess.clamp(start, header.size.saturating_sub(1).max(start));
        let (buf, _) = fetch(guess, PROBE_BYTES)?;
        let Some((i, units)) = find_cluster(&buf) else {
            // No cluster in this stretch (a very long one, or the end): look a little earlier.
            guess = guess.saturating_sub(PROBE_BYTES * 4);
            continue;
        };
        let at = guess + i as u64;
        if last.replace(at) == Some(at) {
            break; // Not getting any closer.
        }
        let secs = units as f64 * secs_per_unit;
        if secs <= target_secs && best.is_none_or(|(_, b)| secs > b) {
            best = Some((at, secs));
        }
        if secs <= target_secs && target_secs - secs <= WINDOW_SECS {
            return Ok(at);
        }
        if secs > 1.0 {
            rate = (at - start) as f64 / secs;
        }
        let next = start as f64 + aim * rate;
        // Overshot: step back a bit further than the estimate says, to land before the time.
        guess = if secs > target_secs { (next - rate * LEAD_SECS).max(start as f64) as u64 } else { next as u64 };
    }
    // Close enough, or the start (FFmpeg then reads its way there, as it would anyway).
    Ok(best.map_or(start, |(at, _)| at))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An element with an 8-byte size.
    fn el(id: u32, body: &[u8]) -> Vec<u8> {
        let id = id.to_be_bytes();
        let mut v = id[id.iter().position(|b| *b != 0).unwrap()..].to_vec();
        v.push(0x01);
        v.extend(&(body.len() as u64).to_be_bytes()[1..]);
        v.extend(body);
        v
    }

    /// A small MKV: SeekHead, Info (1 ms units), Cues, then 60 clusters 10 s apart, each 1000 bytes
    /// and each with a cluster ID inside its data.
    fn film() -> Vec<u8> {
        let mut seek = el(0x4DBB, &[el(0x53AB, &CUES.to_be_bytes()), el(0x53AC, &[0x10])].concat());
        seek = el(SEEK_HEAD, &seek);
        let info = el(INFO, &el(TIMESTAMP_SCALE, &[0x0F, 0x42, 0x40]));
        let cues = el(CUES, &el(0xBB, &[0xB3, 0x81, 0x00]));
        let mut body = [seek, info, cues].concat();
        for n in 0..60u32 {
            let mut data = vec![0xA0; 1000 - 12 - 13];
            data[400..404].copy_from_slice(&CLUSTER.to_be_bytes());
            body.extend(el(CLUSTER, &[el(CLUSTER_TIMESTAMP, &(n * 10_000).to_be_bytes()), data].concat()));
        }
        [el(EBML, &el(0x4286, &[1])), el(SEGMENT, &body)].concat()
    }

    fn fetcher(film: &[u8]) -> impl Fn(u64, u64) -> Result<(Vec<u8>, u64), String> + '_ {
        move |at, len| {
            let start = (at as usize).min(film.len());
            let end = (start + len as usize).min(film.len());
            Ok((film[start..end].to_vec(), film.len() as u64))
        }
    }

    fn first_cluster(film: &[u8]) -> usize {
        film.windows(4).position(|w| w == CLUSTER.to_be_bytes()).unwrap()
    }

    #[test]
    fn reads_ebml_numbers() {
        assert_eq!(read_id(&[0x1A, 0x45, 0xDF, 0xA3], 0), Some((EBML, 4)));
        assert_eq!(read_id(&[0xE7], 0), Some((0xE7, 1)));
        assert_eq!(read_size(&[0x84], 0), Some((Some(4), 1)));
        assert_eq!(read_size(&[0x40, 0x02], 0), Some((Some(2), 2)));
        assert_eq!(read_size(&[0xFF], 0), Some((None, 1)));
        assert_eq!(read_size(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], 0), Some((None, 8)));
    }

    #[test]
    fn finds_the_header_and_blanks_byte_positions() {
        let film = film();
        let h = header("test-film", &fetcher(&film)).unwrap();
        assert_eq!(h.bytes.len(), first_cluster(&film));
        assert_eq!((h.timestamp_scale, h.size), (1_000_000, film.len() as u64));
        let segment_size = 23 + 4; // after the EBML header and the Segment's ID
        assert_eq!(&h.bytes[segment_size..segment_size + 8], &[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], "the size is unknown");
        assert!(h.bytes.windows(4).all(|w| w != SEEK_HEAD.to_be_bytes() && w != CUES.to_be_bytes()));
        assert!(h.bytes.windows(4).any(|w| w == INFO.to_be_bytes()), "the Info stays");
    }

    #[test]
    fn ignores_cluster_ids_inside_data() {
        let film = film();
        let start = first_cluster(&film);
        // From partway into cluster 3, the next real cluster is 4 (at 40 s).
        let (i, units) = find_cluster(&film[start + 3000 + 100..]).unwrap();
        assert_eq!((start + 3100 + i, units), (start + 4000, 40_000));
    }

    #[test]
    fn lands_shortly_before_the_time() {
        let film = film();
        let fetch = fetcher(&film);
        let h = header("test-film-2", &fetch).unwrap();
        for target in [5.0, 100.0, 345.0, 590.0] {
            let at = landing(&h, if target < 300.0 { Some(600.0) } else { None }, target, &fetch).unwrap() as usize;
            let (i, units) = find_cluster(&film[at..]).unwrap();
            let secs = units as f64 / 1000.0;
            assert_eq!(i, 0, "{target}s: lands on a cluster");
            assert!(secs <= target && target - secs <= WINDOW_SECS, "{target}s landed at {secs}s");
        }
    }

    #[test]
    fn reads_clusters_that_start_with_a_checksum() {
        let cluster = el(CLUSTER, &[vec![CRC32, 0x84, 1, 2, 3, 4], el(CLUSTER_TIMESTAMP, &[0x09, 0x27, 0xC0])].concat());
        assert_eq!(find_cluster(&cluster), Some((0, 600_000)));
    }

    #[test]
    fn refuses_what_isnt_mkv() {
        assert_eq!(scan_header(b"\x00\x00\x00\x18ftypmp42"), Scan::NotMkv);
    }
}
