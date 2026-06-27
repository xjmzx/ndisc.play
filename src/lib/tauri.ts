// Typed wrappers around the Rust commands in src-tauri/src/lib.rs, plus
// the asset-protocol URL helper used to feed local files to <audio>/<img>.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Album {
  id: number;
  artist: string;
  album: string;
  year: number | null;
  trackCount: number;
  hasVideo: boolean;
  coverPath: string | null;
}

export interface Track {
  id: number;
  albumId: number;
  path: string;
  title: string;
  trackNo: number | null;
  discNo: number | null;
  duration: number | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  isVideo: boolean;
}

export interface ScanSummary {
  albums: number;
  tracks: number;
  videos: number;
}

export interface ScanProgress {
  phase: "walk" | "read" | "done" | string;
  done: number;
  total: number;
}

export function getConfig(): Promise<{ musicRoot: string }> {
  return invoke("get_config");
}

export function setMusicRoot(path: string): Promise<void> {
  return invoke("set_music_root", { path });
}

export function scanLibrary(): Promise<ScanSummary> {
  return invoke("scan_library");
}

export function listAlbums(): Promise<Album[]> {
  return invoke("list_albums");
}

export function listAlbumTracks(albumId: number): Promise<Track[]> {
  return invoke("list_album_tracks", { albumId });
}

/** Resolve file paths back to library tracks (missing paths are omitted). */
export function tracksByPaths(paths: string[]): Promise<Track[]> {
  return invoke("tracks_by_paths", { paths });
}

export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

export function defaultPlaylistDir(): Promise<string> {
  return invoke("default_playlist_dir");
}

export function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (e) => cb(e.payload));
}

/** asset:// URL for a local file path — used for <img> covers. */
export function fileSrc(path: string): string {
  return convertFileSrc(path);
}

// --- native audio playback (Rust rodio backend) ---------------------------
// WebKit2GTK can't play local media here, so playback is driven over IPC and
// the frontend polls audioStatus() for position / finished.

export interface AudioStatus {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  /** True once (consumed on read) when the track reached its natural end. */
  finished: boolean;
  /** True once (consumed on read) when a load failed — frontend skips it. */
  error: boolean;
}

export function audioPlay(path: string): Promise<void> {
  return invoke("audio_play", { path });
}
export function audioPause(): Promise<void> {
  return invoke("audio_pause");
}
export function audioResume(): Promise<void> {
  return invoke("audio_resume");
}
export function audioStop(): Promise<void> {
  return invoke("audio_stop");
}
export function audioSeek(seconds: number): Promise<void> {
  return invoke("audio_seek", { seconds });
}
export function audioSetVolume(volume: number): Promise<void> {
  return invoke("audio_set_volume", { volume });
}
export function audioStatus(): Promise<AudioStatus> {
  return invoke("audio_status");
}
