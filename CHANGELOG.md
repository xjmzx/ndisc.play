# Changelog

All notable changes to **ndisc.play** (`nplay`). Unlike the publishing/consuming
siblings (ndisc / ndisc.view / glmps), nplay is a local player and **not** a
participant in the ndisc Nostr wire contract, so it tracks a single axis: this
app's own semver, below.

## 0.1.0-beta.1 — unreleased

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

- **VIDEO — a 4th section (planned).** Target layout becomes
  **Collection · Playlist · Now playing · Video**, with Video as the last
  (right-most) section: a real `<video>` surface for the AV files (whose audio
  already plays). Further features may land in this section over time.
- BPM display (aubio, ported from the smpl detector).
- Responsive auto-collapse of panels at narrow widths.
- Playlist reorder (drag / up-down).
