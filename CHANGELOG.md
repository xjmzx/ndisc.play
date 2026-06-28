# Changelog

All notable changes to **ndisc.play** (`nplay`). Unlike the publishing/consuming
siblings (ndisc / ndisc.view / glmps), nplay is a local player and **not** a
participant in the ndisc Nostr wire contract, so it tracks a single axis: this
app's own semver, below.

## 0.1.0-beta.1 — unreleased

### VIDEO section — picture playback — 2026-06-28
- **4th section: Video** (right-most, collapsible). mp4 now plays with picture
  in a webview `<video>` element.
- **Loopback media server.** WebKit2GTK can't play local media over the asset
  protocol (confirmed `MediaError 4`), so a small Rust `tiny_http` server on
  `127.0.0.1` streams library files with full HTTP **Range** support; `<video>`
  points at it. mp4 tracks bypass rodio; non-mp4 video stays audio-only.
- **Unified transport.** The header/footer transport (play/pause, seek, prev,
  volume, auto-advance) drives the `<video>` element for mp4, rodio otherwise;
  the Video panel auto-expands when a video starts.
- **Collection video filter.** A `Video` toggle in the Collection controls
  restricts the tree to video-bearing albums (only their video tracks shown);
  playable mp4 tracks are tinted in the vibrant `digital` hue.
- **Requires `gstreamer1.0-libav`** (provides `avdec_h264`/`avdec_aac`) for
  H.264 playback — a packaging dependency for the eventual `.deb`. Non-mp4
  containers and non-faststart mp4s need conversion (planned ntree batch op).

### Scan feedback + playlist polish — 2026-06-28
- **Persistent header scan meter.** Replaced the terse "%/scanning…" header
  text with a permanent compact progress meter in the header's right cluster:
  a muted track at rest that fills with the accent on scan and settles back,
  in a fixed-width slot so it never shifts the layout. Covers both first import
  and manual re-scan.
- **Smoother, readable progress.** `scan-progress` now carries the current
  file path; an `index` phase flags the (previously silent) album-build + DB
  write; progress emits on a fine cadence (~200 ticks) so the fill sweeps
  rather than jumping. A green "done" bar is held ~900ms after a fast scan so
  completion actually registers.
- **Steady Scan button.** Pinned width so it no longer reflows between
  "Scan"/"Scanning", and its rollover tint latches on (pressed look) for the
  whole scan instead of dimming.
- **Playlist: double-click to play.** Matches the Collection tree's gesture;
  single-click no longer starts playback. Toolbar Play button unchanged.

### Initial player
- **Native local playback (rodio + symphonia).** WebKit2GTK can't play
  app-scheme local media on this stack, so audio is decoded in Rust on a
  dedicated thread and driven over IPC; the frontend polls position/finished.
  Uniform seeking across FLAC/MP3 (+AIFF and video-audio).
- **Indexed SQLite library** of `/data/music` (walkdir + rayon + lofty),
  full wipe-and-rebuild scan; tracks resolved by file path.
- **Collapsible 3-pane layout** — Collection · Playlist · (Now playing +
  Queue) — with sort + filter, collapse-flanks, and a header master transport.
- **Playlists** — working playlist auto-persists by path; Load/Save
  Strawberry-compatible `.xspf`.
- **Video files play audio-only** via an ffmpeg-extracted cached WAV;
  undecodable files flag an error and auto-skip.

## Roadmap

- **Library video normalization** — a batch "Normalize videos" op in **ntree**
  to remux/transcode legacy library videos (mpg/avi/mov, non-faststart mp4) to
  playable H.264/AAC faststart mp4, so nplay plays the whole set with picture.
- BPM display (aubio, ported from the smpl detector).
- Responsive auto-collapse of panels at narrow widths.
- Playlist reorder (drag / up-down).
