// Tauri commands for nplay — a local music/video player for the ndisc
// suite. See https://tauri.app/develop/calling-rust/
//
// The library is indexed into a small SQLite cache (albums + tracks).
// Tags and embedded cover art are read with `lofty` (same crate ndisc
// uses); the walk + parallel tag read mirror ndisc.tree's scanner.
// Playback itself is done webview-side via HTMLMediaElement over the
// asset protocol — no Rust playback command is needed.

use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

// Audio + video extensions — the same sets the rest of the suite
// recognises (ndisc.tree), so "what counts as media" stays consistent.
const AUDIO_EXTS: &[&str] = &[
    "flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif",
    "ape", "wv", "tak", "alac", "mp2", "wma",
];
const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "m4v", "avi", "wmv", "flv", "mpg", "mpeg", "ogv",
];

// Candidate folder-cover filenames, in priority order (case-insensitive
// stem match). First hit wins; otherwise the first image of any kind in
// the folder, otherwise an embedded picture from the first track.
const COVER_STEMS: &[&str] = &["cover", "folder", "front", "album", "albumart", "art"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];

const DEFAULT_MUSIC_ROOT: &str = "/data/music";

fn has_ext(p: &Path, set: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            set.iter().any(|&x| x == lower)
        })
        .unwrap_or(false)
}

fn is_audio(p: &Path) -> bool {
    has_ext(p, AUDIO_EXTS)
}
fn is_video(p: &Path) -> bool {
    has_ext(p, VIDEO_EXTS)
}
fn is_media(p: &Path) -> bool {
    is_audio(p) || is_video(p)
}

// ---- app data dir / config / db -------------------------------------------

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Debug builds (`tauri dev`) use a separate db + config so development
// never clobbers the installed-app library. Matches the suite pattern.
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(debug_assertions) {
        "library-dev.db"
    } else {
        "library.db"
    };
    Ok(app_data_dir(app)?.join(name))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(debug_assertions) {
        "config.dev.json"
    } else {
        "config.json"
    };
    Ok(app_data_dir(app)?.join(name))
}

fn covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?
        .join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY,
  artist      TEXT NOT NULL,
  album       TEXT NOT NULL,
  year        INTEGER,
  dir         TEXT NOT NULL UNIQUE,
  cover_path  TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  has_video   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY,
  album_id    INTEGER NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  track_no    INTEGER,
  disc_no     INTEGER,
  duration    REAL,
  codec       TEXT,
  sample_rate INTEGER,
  bit_depth   INTEGER,
  is_video    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist);
";

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    music_root: String,
}

fn read_music_root(app: &AppHandle) -> String {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("musicRoot")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MUSIC_ROOT.to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> Config {
    Config {
        music_root: read_music_root(&app),
    }
}

#[tauri::command]
fn set_music_root(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("empty path".into());
    }
    let cfg = config_path(&app)?;
    let json = serde_json::json!({ "musicRoot": path });
    fs::write(&cfg, json.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- tag extraction -------------------------------------------------------

/// Per-file metadata gathered during a scan. `dir` (the file's parent
/// folder) is the grouping key for an album.
struct FileMeta {
    path: PathBuf,
    dir: PathBuf,
    is_video: bool,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<i64>,
    track_no: Option<i64>,
    disc_no: Option<i64>,
    duration: Option<f64>,
    codec: Option<String>,
    sample_rate: Option<i64>,
    bit_depth: Option<i64>,
}

fn parse_leading_int(s: &str) -> Option<i64> {
    // "3", "3/12", "03" → 3
    let digits: String = s.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok().filter(|&n| n > 0)
}

fn file_stem_string(p: &Path) -> String {
    p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn ext_upper(p: &Path) -> Option<String> {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_uppercase())
}

fn read_meta(path: &Path) -> FileMeta {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut m = FileMeta {
        path: path.to_path_buf(),
        dir,
        is_video: is_video(path),
        title: None,
        artist: None,
        album: None,
        year: None,
        track_no: None,
        disc_no: None,
        duration: None,
        codec: ext_upper(path),
        sample_rate: None,
        bit_depth: None,
    };

    // Video files: don't probe with lofty (it's an audio tag reader).
    // Use the filename as the title and leave the rest empty.
    if m.is_video {
        m.title = Some(file_stem_string(path));
        return m;
    }

    let opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let Ok(probe) = Probe::open(path) else {
        m.title = Some(file_stem_string(path));
        return m;
    };
    let Ok(tagged) = probe.options(opts).read() else {
        m.title = Some(file_stem_string(path));
        return m;
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        m.title = tag
            .get_string(&ItemKey::TrackTitle)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        m.artist = tag
            .get_string(&ItemKey::AlbumArtist)
            .or_else(|| tag.get_string(&ItemKey::TrackArtist))
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        m.album = tag
            .get_string(&ItemKey::AlbumTitle)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        m.year = tag
            .get_string(&ItemKey::Year)
            .or_else(|| tag.get_string(&ItemKey::RecordingDate))
            .or_else(|| tag.get_string(&ItemKey::OriginalReleaseDate))
            .and_then(|s| s.get(..4).and_then(|p| p.parse::<i64>().ok()));
        m.track_no = tag
            .get_string(&ItemKey::TrackNumber)
            .and_then(parse_leading_int);
        m.disc_no = tag
            .get_string(&ItemKey::DiscNumber)
            .and_then(parse_leading_int);
    }

    let props = tagged.properties();
    let secs = props.duration().as_secs_f64();
    if secs > 0.0 {
        m.duration = Some(secs);
    }
    m.sample_rate = props.sample_rate().map(|v| v as i64);
    m.bit_depth = props.bit_depth().map(|v| v as i64);

    if m.title.is_none() {
        m.title = Some(file_stem_string(path));
    }
    m
}

// ---- cover art ------------------------------------------------------------

fn ext_for_image(mime: Option<&lofty::picture::MimeType>, data: &[u8]) -> &'static str {
    use lofty::picture::MimeType;
    match mime {
        Some(MimeType::Jpeg) => "jpg",
        Some(MimeType::Png) => "png",
        Some(MimeType::Gif) => "gif",
        Some(MimeType::Bmp) => "bmp",
        Some(MimeType::Tiff) => "tiff",
        _ => sniff_image_ext(data),
    }
}

fn sniff_image_ext(data: &[u8]) -> &'static str {
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpg"
    } else if data.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "png"
    } else if data.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WEBP" {
        "webp"
    } else if data.starts_with(b"GIF8") {
        "gif"
    } else {
        "jpg"
    }
}

/// Find a folder cover image in `dir` (by priority stem, then any image).
fn folder_cover(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && has_ext(p, IMAGE_EXTS))
        .collect();
    if entries.is_empty() {
        return None;
    }
    for want in COVER_STEMS {
        for p in &entries {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if stem == *want {
                return Some(p.clone());
            }
        }
    }
    // No named cover — fall back to the alphabetically-first image.
    let mut all = entries;
    all.sort();
    all.into_iter().next()
}

/// Extract the first embedded picture from `audio_path` into the cache
/// dir, keyed by a hash of the album dir. Returns the cache path.
fn extract_embedded_cover(
    audio_path: &Path,
    dir: &Path,
    covers: &Path,
) -> Option<PathBuf> {
    let opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let tagged = Probe::open(audio_path).ok()?.options(opts).read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let picture = tag.pictures().first()?;
    let data = picture.data().to_vec();
    if data.is_empty() {
        return None;
    }
    let ext = ext_for_image(picture.mime_type(), &data);

    let mut h = std::collections::hash_map::DefaultHasher::new();
    dir.hash(&mut h);
    let out = covers.join(format!("{:016x}.{ext}", h.finish()));
    // Reuse an already-extracted cover so re-scans don't rewrite it.
    if !out.exists() {
        fs::write(&out, &data).ok()?;
    }
    Some(out)
}

// ---- scan -----------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: String,
    done: usize,
    total: usize,
    /// The file currently being read (read phase) — for a live "what's it
    /// chewing on" line; empty for the walk/index/done phases.
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    albums: usize,
    tracks: usize,
    videos: usize,
}

/// Pick the most common non-empty value, falling back to `default`.
fn mode_or<'a>(values: impl Iterator<Item = &'a str>, default: &str) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for v in values {
        if !v.is_empty() {
            *counts.entry(v).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|&(_, n)| n)
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| default.to_string())
}

/// Rebuild the whole library index from the configured music root.
/// Emits `scan-progress` events ({phase, done, total}) as it goes.
#[tauri::command]
fn scan_library(app: AppHandle) -> Result<ScanSummary, String> {
    let root = read_music_root(&app);
    let root_pb = PathBuf::from(&root);
    if !root_pb.is_dir() {
        return Err(format!("music root is not a directory: {root}"));
    }
    let covers = covers_dir(&app)?;

    // 1. Walk for media files.
    let _ = app.emit(
        "scan-progress",
        ScanProgress { phase: "walk".into(), done: 0, total: 0, path: String::new() },
    );
    let files: Vec<PathBuf> = WalkDir::new(&root_pb)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media(e.path()))
        .map(|e| e.into_path())
        .collect();
    let total = files.len();

    // 2. Read tags in parallel. Emit progress on a fine cadence (~200 ticks
    //    across the whole library) so the header bar sweeps smoothly even on
    //    a fast scan rather than jumping in coarse steps.
    let counter = AtomicUsize::new(0);
    let step = (total / 200).max(1);
    let metas: Vec<FileMeta> = files
        .par_iter()
        .map(|p| {
            let m = read_meta(p);
            let done = counter.fetch_add(1, Ordering::Relaxed) + 1;
            if done % step == 0 || done == total {
                let _ = app.emit(
                    "scan-progress",
                    ScanProgress {
                        phase: "read".into(),
                        done,
                        total,
                        path: p.to_string_lossy().into_owned(),
                    },
                );
            }
            m
        })
        .collect();

    // Tags are read; the rest (grouping, cover extraction, DB rewrite) is a
    // silent stretch on a large library, so flag an indeterminate "index"
    // phase before it rather than letting the bar sit at 100%.
    let _ = app.emit(
        "scan-progress",
        ScanProgress { phase: "index".into(), done: total, total, path: String::new() },
    );

    // 3. Group by parent directory into albums.
    let mut groups: HashMap<PathBuf, Vec<FileMeta>> = HashMap::new();
    for m in metas {
        groups.entry(m.dir.clone()).or_default().push(m);
    }

    // 4. Build albums (covers resolved in parallel — disk-bound).
    let root_for_album = root_pb.clone();
    let mut albums: Vec<AlbumAgg> = groups
        .into_par_iter()
        .map(|(dir, mut tracks)| {
            tracks.sort_by(|a, b| {
                (a.disc_no, a.track_no, &a.path)
                    .cmp(&(b.disc_no, b.track_no, &b.path))
            });
            let artist_default = artist_from_path(&dir, &root_for_album);
            let artist = mode_or(
                tracks.iter().filter_map(|t| t.artist.as_deref()),
                &artist_default,
            );
            let album_default = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string();
            let album = mode_or(
                tracks.iter().filter_map(|t| t.album.as_deref()),
                &album_default,
            );
            let year = tracks.iter().filter_map(|t| t.year).min();
            let has_video = tracks.iter().any(|t| t.is_video);

            let cover = folder_cover(&dir).or_else(|| {
                tracks
                    .iter()
                    .find(|t| !t.is_video)
                    .and_then(|t| extract_embedded_cover(&t.path, &dir, &covers))
            });

            AlbumAgg {
                dir,
                artist,
                album,
                year,
                cover_path: cover.map(|p| p.to_string_lossy().into_owned()),
                has_video,
                tracks,
            }
        })
        .collect();

    albums.sort_by(|a, b| {
        a.artist
            .to_lowercase()
            .cmp(&b.artist.to_lowercase())
            .then(a.year.cmp(&b.year))
            .then(a.album.to_lowercase().cmp(&b.album.to_lowercase()))
    });

    // 5. Rewrite the index in one transaction (full rebuild — the index
    //    is derived, so wipe-and-replace is the simplest correct path).
    let mut conn = open(&app)?;
    let mut n_tracks = 0usize;
    let mut n_videos = 0usize;
    let n_albums = albums.len();
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM tracks", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM albums", []).map_err(|e| e.to_string())?;
        for a in &albums {
            tx.execute(
                "INSERT INTO albums (artist, album, year, dir, cover_path, track_count, has_video)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    a.artist,
                    a.album,
                    a.year,
                    a.dir.to_string_lossy(),
                    a.cover_path,
                    a.tracks.len() as i64,
                    a.has_video as i64,
                ],
            )
            .map_err(|e| e.to_string())?;
            let album_id = tx.last_insert_rowid();
            for t in &a.tracks {
                tx.execute(
                    "INSERT OR IGNORE INTO tracks
                     (album_id, path, title, track_no, disc_no, duration, codec, sample_rate, bit_depth, is_video)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        album_id,
                        t.path.to_string_lossy(),
                        t.title.as_deref().unwrap_or(""),
                        t.track_no,
                        t.disc_no,
                        t.duration,
                        t.codec,
                        t.sample_rate,
                        t.bit_depth,
                        t.is_video as i64,
                    ],
                )
                .map_err(|e| e.to_string())?;
                n_tracks += 1;
                if t.is_video {
                    n_videos += 1;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    let _ = app.emit(
        "scan-progress",
        ScanProgress { phase: "done".into(), done: total, total, path: String::new() },
    );

    Ok(ScanSummary {
        albums: n_albums,
        tracks: n_tracks,
        videos: n_videos,
    })
}

struct AlbumAgg {
    dir: PathBuf,
    artist: String,
    album: String,
    year: Option<i64>,
    cover_path: Option<String>,
    has_video: bool,
    tracks: Vec<FileMeta>,
}

/// Default artist when no tag is present: the name of the album dir's
/// parent (…/Artist/Album), unless the album dir sits directly under the
/// music root (…/Artist with loose tracks), where the album dir name is
/// the best guess.
fn artist_from_path(dir: &Path, root: &Path) -> String {
    if dir.parent() == Some(root) {
        return dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();
    }
    dir.parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

// ---- queries --------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumRow {
    id: i64,
    artist: String,
    album: String,
    year: Option<i64>,
    track_count: i64,
    has_video: bool,
    cover_path: Option<String>,
}

#[tauri::command]
fn list_albums(app: AppHandle) -> Result<Vec<AlbumRow>, String> {
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, artist, album, year, track_count, has_video, cover_path
             FROM albums
             ORDER BY artist COLLATE NOCASE, year, album COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AlbumRow {
                id: r.get(0)?,
                artist: r.get(1)?,
                album: r.get(2)?,
                year: r.get(3)?,
                track_count: r.get(4)?,
                has_video: r.get::<_, i64>(5)? != 0,
                cover_path: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackRow {
    id: i64,
    album_id: i64,
    path: String,
    title: String,
    track_no: Option<i64>,
    disc_no: Option<i64>,
    duration: Option<f64>,
    codec: Option<String>,
    sample_rate: Option<i64>,
    bit_depth: Option<i64>,
    is_video: bool,
}

#[tauri::command]
fn list_album_tracks(app: AppHandle, album_id: i64) -> Result<Vec<TrackRow>, String> {
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, album_id, path, title, track_no, disc_no, duration,
                    codec, sample_rate, bit_depth, is_video
             FROM tracks WHERE album_id = ?1
             ORDER BY disc_no, track_no, path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![album_id], |r| {
            Ok(TrackRow {
                id: r.get(0)?,
                album_id: r.get(1)?,
                path: r.get(2)?,
                title: r.get(3)?,
                track_no: r.get(4)?,
                disc_no: r.get(5)?,
                duration: r.get(6)?,
                codec: r.get(7)?,
                sample_rate: r.get(8)?,
                bit_depth: r.get(9)?,
                is_video: r.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn map_track_row(r: &rusqlite::Row) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: r.get(0)?,
        album_id: r.get(1)?,
        path: r.get(2)?,
        title: r.get(3)?,
        track_no: r.get(4)?,
        disc_no: r.get(5)?,
        duration: r.get(6)?,
        codec: r.get(7)?,
        sample_rate: r.get(8)?,
        bit_depth: r.get(9)?,
        is_video: r.get::<_, i64>(10)? != 0,
    })
}

/// Resolve a list of file paths back to library tracks (used to rebuild a
/// persisted/imported playlist with fresh ids + album links after a rescan).
/// Paths not in the library are simply absent from the result.
#[tauri::command]
fn tracks_by_paths(app: AppHandle, paths: Vec<String>) -> Result<Vec<TrackRow>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let conn = open(&app)?;
    let placeholders = vec!["?"; paths.len()].join(",");
    let sql = format!(
        "SELECT id, album_id, path, title, track_no, disc_no, duration, codec,
                sample_rate, bit_depth, is_video
         FROM tracks WHERE path IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(paths.iter()), map_track_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(p) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(p);
    }
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Default folder for playlist files — the user's Strawberry playlist dir.
#[tauri::command]
fn default_playlist_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join("Music")
        .join("Strawberry");
    Ok(dir.to_string_lossy().into_owned())
}

// ---- native audio playback (rodio) ---------------------------------------
//
// WebKit2GTK's media element here refuses to play from any app URI scheme
// (asset:// and a custom range scheme both yield MediaError 4), and a
// whole-file blob: URL stutters on long tracks. So playback lives in Rust:
// a dedicated thread owns the cpal OutputStream (which is !Send) + a rodio
// Sink and reacts to commands sent over a channel; the frontend drives it
// via commands and polls `audio_status` for position / finished.

enum AudioCmd {
    Play(String),
    Pause,
    Resume,
    Toggle,
    Stop,
    Seek(f64),
    SetVolume(f32),
}

#[derive(Default)]
struct AudioShared {
    position_ms: AtomicU64,
    /// Decoder-reported duration; 0 when unknown (frontend falls back to
    /// the tag duration it already holds).
    duration_ms: AtomicU64,
    playing: AtomicBool,
    /// Set when the current track reached its natural end; consumed (reset)
    /// on read so the frontend advances the queue exactly once.
    finished: AtomicBool,
    /// Set when a Play command failed to load (undecodable / no audio).
    /// Consumed on read so the frontend skips that track once.
    error: AtomicBool,
}

struct AudioState {
    tx: Mutex<std::sync::mpsc::Sender<AudioCmd>>,
    shared: Arc<AudioShared>,
}

/// Extract a video file's audio track to a cached WAV via ffmpeg, so the
/// rodio engine can play it (audio-only). Cached by path hash — first play
/// transcodes (~1-3s), later plays reuse the WAV. Returns the WAV path.
fn transcode_video_audio(src: &str, cache_dir: &Path) -> Result<PathBuf, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    src.hash(&mut h);
    let out = cache_dir.join(format!("{:016x}.wav", h.finish()));
    if out.exists() && fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out);
    }
    let status = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-i", src, "-vn", "-c:a", "pcm_s16le"])
        .arg(&out)
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg not found on PATH".to_string()
            } else {
                format!("ffmpeg launch failed: {e}")
            }
        })?;
    if !status.success() {
        let _ = fs::remove_file(&out);
        return Err("ffmpeg failed to extract audio".to_string());
    }
    Ok(out)
}

fn spawn_audio_thread(
    rx: std::sync::mpsc::Receiver<AudioCmd>,
    shared: Arc<AudioShared>,
    cache_dir: PathBuf,
) {
    use rodio::{Decoder, OutputStream, Sink, Source};
    use std::io::BufReader;
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;

    std::thread::spawn(move || {
        let (_stream, handle) = match OutputStream::try_default() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("audio: no output device: {e}");
                return;
            }
        };
        let mut sink = match Sink::try_new(&handle) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("audio: sink: {e}");
                return;
            }
        };
        let mut volume: f32 = 1.0;
        // True while a track is loaded and expected to play to its end —
        // distinguishes a natural finish (sink empties on its own) from an
        // explicit Stop / replace.
        let mut active = false;

        loop {
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(AudioCmd::Play(path)) => {
                    // Video files: extract their audio to a cached WAV first
                    // (rodio is audio-only and can't pick the audio track out
                    // of a video container). Audio files decode directly.
                    let src = if is_video(Path::new(&path)) {
                        match transcode_video_audio(&path, &cache_dir) {
                            Ok(p) => Some(p.to_string_lossy().into_owned()),
                            Err(e) => {
                                eprintln!("audio: video extract {path}: {e}");
                                None
                            }
                        }
                    } else {
                        Some(path.clone())
                    };
                    // Decode first; only stop the current track + swap the sink
                    // if the new file actually loads, so an undecodable file
                    // never kills what's playing. On failure, flag an error so
                    // the frontend skips to the next track.
                    let loaded = src.ok_or_else(|| "no audio".to_string()).and_then(|p| {
                        std::fs::File::open(&p)
                            .map_err(|e| e.to_string())
                            .and_then(|f| {
                                Decoder::new(BufReader::new(f)).map_err(|e| e.to_string())
                            })
                    });
                    match loaded {
                        Ok(dec) => {
                            let dur =
                                dec.total_duration().map(|d| d.as_millis() as u64).unwrap_or(0);
                            sink.stop();
                            sink = match Sink::try_new(&handle) {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            sink.set_volume(volume);
                            shared.duration_ms.store(dur, Ordering::Relaxed);
                            shared.position_ms.store(0, Ordering::Relaxed);
                            shared.finished.store(false, Ordering::Relaxed);
                            shared.error.store(false, Ordering::Relaxed);
                            sink.append(dec);
                            sink.play();
                            active = true;
                        }
                        Err(e) => {
                            // Keep current playback running; flag for skip.
                            eprintln!("audio: load {path}: {e}");
                            shared.error.store(true, Ordering::Relaxed);
                        }
                    }
                }
                Ok(AudioCmd::Pause) => sink.pause(),
                Ok(AudioCmd::Resume) => sink.play(),
                Ok(AudioCmd::Toggle) => {
                    if sink.is_paused() {
                        sink.play()
                    } else {
                        sink.pause()
                    }
                }
                Ok(AudioCmd::Stop) => {
                    sink.stop();
                    active = false;
                    shared.position_ms.store(0, Ordering::Relaxed);
                }
                Ok(AudioCmd::Seek(secs)) => {
                    let _ = sink.try_seek(Duration::from_secs_f64(secs.max(0.0)));
                }
                Ok(AudioCmd::SetVolume(v)) => {
                    volume = v.clamp(0.0, 1.0);
                    sink.set_volume(volume);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }

            // Publish status for the frontend poll.
            shared
                .position_ms
                .store(sink.get_pos().as_millis() as u64, Ordering::Relaxed);
            if active && sink.empty() {
                active = false;
                shared.finished.store(true, Ordering::Relaxed);
                shared.playing.store(false, Ordering::Relaxed);
            } else {
                shared
                    .playing
                    .store(active && !sink.is_paused(), Ordering::Relaxed);
            }
        }
    });
}

fn send(state: &State<AudioState>, cmd: AudioCmd) -> Result<(), String> {
    state
        .tx
        .lock()
        .map_err(|e| e.to_string())?
        .send(cmd)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn audio_play(state: State<AudioState>, path: String) -> Result<(), String> {
    send(&state, AudioCmd::Play(path))
}
#[tauri::command]
fn audio_pause(state: State<AudioState>) -> Result<(), String> {
    send(&state, AudioCmd::Pause)
}
#[tauri::command]
fn audio_resume(state: State<AudioState>) -> Result<(), String> {
    send(&state, AudioCmd::Resume)
}
#[tauri::command]
fn audio_toggle(state: State<AudioState>) -> Result<(), String> {
    send(&state, AudioCmd::Toggle)
}
#[tauri::command]
fn audio_stop(state: State<AudioState>) -> Result<(), String> {
    send(&state, AudioCmd::Stop)
}
#[tauri::command]
fn audio_seek(state: State<AudioState>, seconds: f64) -> Result<(), String> {
    send(&state, AudioCmd::Seek(seconds))
}
#[tauri::command]
fn audio_set_volume(state: State<AudioState>, volume: f32) -> Result<(), String> {
    send(&state, AudioCmd::SetVolume(volume))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStatus {
    position_ms: u64,
    duration_ms: u64,
    playing: bool,
    finished: bool,
    error: bool,
}

#[tauri::command]
fn audio_status(state: State<AudioState>) -> AudioStatus {
    let s = &state.shared;
    AudioStatus {
        position_ms: s.position_ms.load(Ordering::Relaxed),
        duration_ms: s.duration_ms.load(Ordering::Relaxed),
        playing: s.playing.load(Ordering::Relaxed),
        finished: s.finished.swap(false, Ordering::Relaxed),
        error: s.error.swap(false, Ordering::Relaxed),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// --- loopback media server ------------------------------------------------
// WebKit2GTK can't play local media over app URI schemes (asset:// →
// MediaError 4), so the webview <video> element streams from a tiny
// 127.0.0.1 HTTP server with Range support instead. Loopback-only and it
// only serves existing files the suite recognises as media.

/// Base URL of the loopback media server (`http://127.0.0.1:<port>`).
struct MediaServer {
    base: String,
}

#[tauri::command]
fn media_base(server: State<MediaServer>) -> String {
    server.base.clone()
}

fn content_type_for(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        _ => "application/octet-stream",
    }
}

/// Parse a `bytes=start-end` range against a known length. Supports an open
/// end (`start-`) and a suffix range (`-N` = last N bytes).
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let (start_s, end_s) = spec.split_once('-')?;
    if start_s.is_empty() {
        let n: u64 = end_s.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end = if end_s.is_empty() {
        len - 1
    } else {
        end_s.parse::<u64>().ok()?.min(len - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header")
}

fn serve_media(req: tiny_http::Request) -> std::io::Result<()> {
    // Pull the `path` query parameter and percent-decode it.
    let url = req.url().to_string();
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
    let raw = query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == "path").then_some(v)
    });
    let path = match raw {
        Some(v) => PathBuf::from(
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned(),
        ),
        None => return req.respond(tiny_http::Response::empty(400)),
    };
    if !path.is_file() || !is_media(&path) {
        return req.respond(tiny_http::Response::empty(404));
    }

    let mut file = fs::File::open(&path)?;
    let len = file.metadata()?.len();
    let ctype = content_type_for(&path);
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let mut headers = vec![
        header("Content-Type", ctype),
        header("Accept-Ranges", "bytes"),
        header("Access-Control-Allow-Origin", "*"),
        header("Cache-Control", "no-store"),
    ];

    match range.and_then(|r| parse_range(&r, len)) {
        Some((start, end)) => {
            let chunk = end - start + 1;
            file.seek(SeekFrom::Start(start))?;
            headers.push(header(
                "Content-Range",
                &format!("bytes {start}-{end}/{len}"),
            ));
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(206),
                headers,
                file.take(chunk),
                Some(chunk as usize),
                None,
            );
            req.respond(resp)
        }
        None => {
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(200),
                headers,
                file,
                Some(len as usize),
                None,
            );
            req.respond(resp)
        }
    }
}

/// Bind the loopback server on an ephemeral port and serve in a background
/// thread. Returns the bound port.
fn spawn_media_server() -> std::io::Result<u16> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(0);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            if let Err(e) = serve_media(req) {
                eprintln!("media server error: {e}");
            }
        }
    });
    Ok(port)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Cache dir for ffmpeg-extracted video audio (disposable).
            let cache = app
                .path()
                .app_cache_dir()
                .map(|d| d.join("videoaudio"))
                .unwrap_or_else(|_| std::env::temp_dir().join("nplay-videoaudio"));
            let _ = fs::create_dir_all(&cache);
            let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
            let shared = Arc::new(AudioShared::default());
            spawn_audio_thread(rx, shared.clone(), cache);
            app.manage(AudioState {
                tx: Mutex::new(tx),
                shared,
            });

            // Loopback server for webview <video> playback of local media.
            let media_port = spawn_media_server()?;
            app.manage(MediaServer {
                base: format!("http://127.0.0.1:{media_port}"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_music_root,
            scan_library,
            list_albums,
            list_album_tracks,
            tracks_by_paths,
            read_text_file,
            write_text_file,
            default_playlist_dir,
            audio_play,
            audio_pause,
            audio_resume,
            audio_toggle,
            audio_stop,
            audio_seek,
            audio_set_volume,
            audio_status,
            media_base
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
