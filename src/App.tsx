import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Film,
  FolderOpen,
  ListMusic,
  ListPlus,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  Search,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { cn } from "./lib/cn";
import { Section } from "./components/Section";
import { CollapsedStrip } from "./components/CollapsedStrip";
import { LibraryTree, type SortKey } from "./components/LibraryTree";
import { NowPlaying } from "./components/NowPlaying";
import { PlayerBar } from "./components/PlayerBar";
import { Playlist } from "./components/Playlist";
import { Queue } from "./components/Queue";
import { ScanProgressBar } from "./components/ScanProgressBar";
import { Video } from "./components/Video";
import {
  audioPause,
  audioPlay,
  audioResume,
  audioSeek,
  audioSetVolume,
  audioStatus,
  audioStop,
  defaultPlaylistDir,
  getConfig,
  listAlbums,
  mediaBase,
  onScanProgress,
  readTextFile,
  scanLibrary,
  setMusicRoot,
  tracksByPaths,
  writeTextFile,
  type Album,
  type ScanProgress,
  type Track,
} from "./lib/tauri";
import { buildXspf, parseXspf, type XspfItem } from "./lib/xspf";

const VOLUME_KEY = "nplay.volume";
const PLAYLIST_KEY = "nplay.playlist";

/** Minimal persisted playlist entry (path is the stable key). */
interface SavedEntry {
  path: string;
  title: string;
  duration: number | null;
}

/** Build a Track from an entry the library couldn't resolve (file moved, or
 *  an .xspf pointing outside the library) so it still shows + plays by path. */
function synthTrack(e: SavedEntry | XspfItem, i: number): Track {
  return {
    id: -(i + 1),
    albumId: -1,
    path: e.path,
    title: e.title || e.path.split("/").pop() || e.path,
    trackNo: null,
    discNo: null,
    duration: e.duration ?? null,
    codec: null,
    sampleRate: null,
    bitDepth: null,
    isVideo: false,
  };
}

/** Resolve persisted/imported entries to library Tracks (preserving order),
 *  synthesizing any the library doesn't know. */
async function resolveEntries(
  entries: Array<SavedEntry | XspfItem>,
): Promise<Track[]> {
  if (!entries.length) return [];
  const found = await tracksByPaths(entries.map((e) => e.path));
  const byPath = new Map(found.map((t) => [t.path, t]));
  return entries.map((e, i) => byPath.get(e.path) ?? synthTrack(e, i));
}

/** A boolean persisted to localStorage (panel collapse states). */
function usePersistedBool(key: string, def = false) {
  const [v, setV] = useState(() => {
    const s = localStorage.getItem(key);
    return s === "1" ? true : s === "0" ? false : def;
  });
  useEffect(() => {
    localStorage.setItem(key, v ? "1" : "0");
  }, [key, v]);
  return [v, setV] as const;
}

export default function App() {
  const [musicRoot, setRoot] = useState("");
  const [mediaBaseUrl, setMediaBaseUrl] = useState("");
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loadingAlbums, setLoadingAlbums] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playlist, setPlaylist] = useState<Track[]>([]);
  const [playlistDir, setPlaylistDir] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("artist");
  const [filter, setFilter] = useState("");
  const [videoOnly, setVideoOnly] = useState(false);
  const [colCollapsed, setColCollapsed] = usePersistedBool("nplay.col.collapsed");
  const [plCollapsed, setPlCollapsed] = usePersistedBool("nplay.playlist.collapsed");
  const [npCollapsed, setNpCollapsed] = usePersistedBool("nplay.nowplaying.collapsed");
  const [vidCollapsed, setVidCollapsed] = usePersistedBool("nplay.video.collapsed");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const s = localStorage.getItem(VOLUME_KEY);
    const v = s != null ? parseFloat(s) : NaN;
    return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });

  const current = index >= 0 && index < queue.length ? queue[index] : null;
  // mp4 videos are driven by the webview <video> element (rodio can't draw a
  // picture); everything else (audio + non-mp4 video audio) goes to rodio.
  const currentIsMp4 = !!current?.isVideo && /\.mp4$/i.test(current.path);

  const albumById = useMemo(() => {
    const m = new Map<number, Album>();
    for (const a of albums) m.set(a.id, a);
    return m;
  }, [albums]);
  const currentAlbum = current ? albumById.get(current.albumId) ?? null : null;

  // --- data loading ---------------------------------------------------------
  async function refreshAlbums() {
    setLoadingAlbums(true);
    try {
      setAlbums(await listAlbums());
    } finally {
      setLoadingAlbums(false);
    }
  }

  useEffect(() => {
    getConfig().then((c) => setRoot(c.musicRoot));
    mediaBase().then(setMediaBaseUrl).catch(() => {});
    refreshAlbums();
    const un = onScanProgress(setProgress);
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function doScan() {
    setScanning(true);
    setProgress({ phase: "walk", done: 0, total: 0, path: "" });
    try {
      await scanLibrary();
      await refreshAlbums();
      // The scan can finish in a second or two; hold a full "done" bar briefly
      // so the user actually sees it complete instead of a flicker.
      setProgress({ phase: "done", done: 1, total: 1, path: "" });
      await new Promise((r) => setTimeout(r, 900));
    } catch (e) {
      console.error("scan failed", e);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  async function chooseRoot() {
    const picked = await open({ directory: true, defaultPath: musicRoot });
    if (typeof picked === "string" && picked) {
      await setMusicRoot(picked);
      setRoot(picked);
      await doScan();
    }
  }

  // --- playback (Rust rodio backend over IPC) -------------------------------
  // Video files play audio-only (Rust extracts the track via ffmpeg). A file
  // that genuinely can't be decoded flags `error` in the status poll and is
  // skipped to the next track. Latest next handler held in a ref so the poll
  // never closes over stale queue/index state.
  // The webview <video> element (mounted by the Video section for mp4 tracks);
  // the app transport drives it directly for video, rodio for everything else.
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const nextRef = useRef<() => void>(() => {});
  nextRef.current = () => {
    if (index < queue.length - 1) setIndex(index + 1);
    else {
      setIsPlaying(false);
      audioStop().catch(() => {});
    }
  };

  function play(tracks: Track[], startIndex: number) {
    setQueue(tracks);
    setIndex(startIndex);
  }

  // --- playlist (staging list; playing it loads it into the queue) ---------
  function addToPlaylist(tracks: Track[]) {
    setPlaylist((p) => [...p, ...tracks]);
  }
  function playPlaylistAt(i: number) {
    if (playlist.length) play(playlist, Math.max(0, Math.min(i, playlist.length - 1)));
  }
  function removeFromPlaylist(i: number) {
    setPlaylist((p) => p.filter((_, j) => j !== i));
  }
  function clearPlaylist() {
    setPlaylist([]);
  }

  // Auto-persist the working playlist by path, and restore it on launch
  // (resolving paths back to fresh library tracks). `hydrated` gates the
  // save effect so the initial empty render doesn't clobber saved data.
  const hydratedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(PLAYLIST_KEY);
        const entries = raw ? (JSON.parse(raw) as SavedEntry[]) : [];
        if (Array.isArray(entries) && entries.length) {
          setPlaylist(await resolveEntries(entries));
        }
      } catch (e) {
        console.error("playlist restore failed", e);
      }
      hydratedRef.current = true;
    })();
    defaultPlaylistDir()
      .then(setPlaylistDir)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const entries: SavedEntry[] = playlist.map((t) => ({
      path: t.path,
      title: t.title,
      duration: t.duration,
    }));
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify(entries));
  }, [playlist]);

  // Import a Strawberry/XSPF playlist into the working list.
  async function loadPlaylistFile() {
    const picked = await open({
      defaultPath: playlistDir ?? undefined,
      filters: [{ name: "XSPF playlist", extensions: ["xspf"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    try {
      const items = parseXspf(await readTextFile(picked));
      setPlaylist(await resolveEntries(items));
    } catch (e) {
      console.error("playlist load failed", e);
    }
  }

  // Export the working list as an .xspf (Strawberry-compatible).
  async function savePlaylistFile() {
    if (!playlist.length) return;
    const dest = await save({
      defaultPath: `${playlistDir ? playlistDir + "/" : ""}nplay.xspf`,
      filters: [{ name: "XSPF playlist", extensions: ["xspf"] }],
    });
    if (!dest) return;
    const items: XspfItem[] = playlist.map((t) => ({
      path: t.path,
      title: t.title,
      artist: albumById.get(t.albumId)?.artist ?? "",
      duration: t.duration ?? null,
    }));
    try {
      await writeTextFile(dest, buildXspf(items));
    } catch (e) {
      console.error("playlist save failed", e);
    }
  }

  function toggle() {
    if (!current) return;
    if (currentIsMp4) {
      const el = videoElRef.current;
      if (!el) return;
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      setIsPlaying(!el.paused);
      return;
    }
    if (isPlaying) {
      setIsPlaying(false);
      audioPause().catch(() => {});
    } else {
      setIsPlaying(true);
      audioResume().catch(() => {});
    }
  }

  function prev() {
    const restart = () => {
      if (currentIsMp4) {
        if (videoElRef.current) videoElRef.current.currentTime = 0;
      } else {
        audioSeek(0).catch(() => {});
      }
      setCurrentTime(0);
    };
    if (currentTime > 3) return restart();
    if (index > 0) setIndex(index - 1);
    else restart();
  }

  function seek(t: number) {
    if (currentIsMp4) {
      if (videoElRef.current) videoElRef.current.currentTime = t;
    } else {
      audioSeek(t).catch(() => {});
    }
    setCurrentTime(t);
  }

  function changeVolume(v: number) {
    setVolume(v);
    localStorage.setItem(VOLUME_KEY, String(v));
    audioSetVolume(v).catch(() => {});
    if (videoElRef.current) videoElRef.current.volume = v;
  }

  // Push the restored volume to the audio engine once on startup so the
  // backend matches the slider before the first track plays.
  useEffect(() => {
    audioSetVolume(volume).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start playback whenever the current track changes (videos included —
  // Rust extracts their audio; the first play of a video transcodes, so it
  // may take a second or two to start).
  useEffect(() => {
    if (!current) return;
    setCurrentTime(0);
    setDuration(current.duration ?? 0);
    setIsPlaying(true);
    // mp4 → the <video> element owns playback (picture + sound); stop rodio,
    // and make sure the Video panel is open so the element actually exists.
    if (currentIsMp4) {
      audioStop().catch(() => {});
      setVidCollapsed(false);
      if (videoElRef.current) videoElRef.current.volume = volume;
      return;
    }
    audioPlay(current.path).catch((e) => console.error("play failed", e));
    audioSetVolume(volume).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Poll the backend for position / finished while a track is loaded.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const id = setInterval(async () => {
      // Video tracks: read position/duration straight off the <video> element
      // (it owns playback). It may not exist yet if the panel is mid-mount.
      if (currentIsMp4) {
        const el = videoElRef.current;
        if (!el || !alive) return;
        setCurrentTime(el.currentTime || 0);
        if (el.duration && isFinite(el.duration)) setDuration(el.duration);
        setIsPlaying(!el.paused && !el.ended);
        if (el.ended) nextRef.current();
        return;
      }
      try {
        const s = await audioStatus();
        if (!alive) return;
        // A failed load (undecodable / audioless video) — skip to next.
        if (s.error) {
          nextRef.current();
          return;
        }
        setCurrentTime(s.positionMs / 1000);
        if (s.durationMs > 0) setDuration(s.durationMs / 1000);
        setIsPlaying(s.playing);
        if (s.finished) nextRef.current();
      } catch {
        /* transient */
      }
    }, 250);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const canNext = index >= 0 && index < queue.length - 1;

  // Header master-transport button — matches ndisc.smpl's MasterStrip
  // styling (h-8 square, surface fill, accent glyph) for suite consistency.
  const hdrBtn =
    "h-8 w-8 rounded-md bg-surface text-accent hover:bg-accent/15 transition-colors " +
    "flex items-center justify-center shrink-0 disabled:opacity-40 disabled:hover:bg-surface";

  // Collapse-flanks: each column is its content width or a 2.5rem sliver.
  // Collection is the greedy fr so collapsing a neighbour widens it.
  const mainCols = [
    colCollapsed ? "2.5rem" : "minmax(0, 1.5fr)",
    plCollapsed ? "2.5rem" : "minmax(0, 1fr)",
    npCollapsed ? "2.5rem" : "300px",
    vidCollapsed ? "2.5rem" : "minmax(0, 1fr)",
  ].join(" ");

  const albumCount = albums.length;

  return (
    <div className="h-full flex flex-col bg-bg text-fg">
      {/* Header — [ title + folder ] [ master transport ] [ scan ] */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5 border-b border-surface/60 bg-panel/60">
        <div className="flex items-center gap-3 min-w-0">
          <Music size={18} className="text-accent shrink-0" />
          <h1 className="text-sm font-semibold tracking-wide shrink-0">
            ndisc<span className="text-muted">.play</span>
          </h1>
          <button
            onClick={chooseRoot}
            title="Choose music folder"
            className="flex items-center gap-1.5 min-w-0 text-[12px] text-muted hover:text-fg/90 transition-colors"
          >
            <FolderOpen size={14} className="shrink-0" />
            <span className="truncate max-w-[280px]">{musicRoot || "…"}</span>
          </button>
        </div>

        {/* Master transport — mirrors the bottom bar; matches smpl's header. */}
        <div className="inline-flex gap-1 justify-self-center">
          <button
            onClick={prev}
            disabled={!current}
            title="Previous"
            aria-label="Previous"
            className={hdrBtn}
          >
            <SkipBack size={15} fill="currentColor" />
          </button>
          <button
            onClick={toggle}
            disabled={!current}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            className={hdrBtn}
          >
            {isPlaying ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
          </button>
          <button
            onClick={() => nextRef.current()}
            disabled={!canNext}
            title="Next"
            aria-label="Next"
            className={hdrBtn}
          >
            <SkipForward size={15} fill="currentColor" />
          </button>
        </div>

        <div className="flex items-center gap-3 shrink-0 justify-self-end">
          {/* Permanent scan meter — muted track at rest, accent fill on scan. */}
          <ScanProgressBar progress={progress} active={scanning} />
          <span className="text-[12px] text-muted">{albumCount} albums</span>
          <button
            onClick={doScan}
            disabled={scanning}
            className={cn(
              "flex items-center justify-center gap-1.5 min-w-[6.5rem] text-[12px] px-2.5 py-1 rounded-md transition-colors",
              // Keep the rollover tint latched on while scanning (pressed look).
              scanning ? "bg-surfaceHover" : "bg-surface/70 hover:bg-surfaceHover",
            )}
          >
            {scanning ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {scanning ? "Scanning" : "Scan"}
          </button>
        </div>
      </header>

      {/* Main — Collection · Playlist · (Now playing + Queue), collapsible */}
      <div
        className="flex-1 min-h-0 grid gap-3 p-3"
        style={{ gridTemplateColumns: mainCols }}
      >
        {/* Collection (with sort + filter) */}
        {colCollapsed ? (
          <CollapsedStrip
            title="Collection"
            icon={<ListMusic size={15} />}
            onExpand={() => setColCollapsed(false)}
          />
        ) : (
          <Section
            title="Collection"
            icon={<ListMusic size={15} />}
            elastic
            className="min-w-0"
            onTitleClick={() => setColCollapsed(true)}
          >
            {/* sort + filter controls */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="inline-flex rounded-md bg-surface/60 p-0.5 text-[11px] shrink-0">
                {(["artist", "album", "year"] as SortKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={cn(
                      "px-2 py-0.5 rounded capitalize transition-colors",
                      sort === k
                        ? "bg-accent/20 text-accent"
                        : "text-muted hover:text-fg/80",
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setVideoOnly((v) => !v)}
                title="Show only albums with video"
                aria-pressed={videoOnly}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] shrink-0 transition-colors",
                  videoOnly
                    ? "bg-accent/20 text-accent"
                    : "bg-surface/60 text-muted hover:text-fg/80",
                )}
              >
                <Film size={12} /> Video
              </button>
              <div className="relative flex-1 min-w-0">
                <Search
                  size={13}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
                />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  className="w-full pl-7 pr-2 py-1 rounded-md bg-surface/60 text-[12px] placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              {loadingAlbums ? (
                <div className="px-2 py-4 text-sm text-muted flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> loading library…
                </div>
              ) : (
                <LibraryTree
                  albums={albums}
                  currentTrackId={current?.id ?? null}
                  onPlay={play}
                  onAddToPlaylist={addToPlaylist}
                  sort={sort}
                  filter={filter}
                  videoOnly={videoOnly}
                />
              )}
            </div>
          </Section>
        )}

        {/* Playlist */}
        {plCollapsed ? (
          <CollapsedStrip
            title="Playlist"
            icon={<ListPlus size={15} />}
            onExpand={() => setPlCollapsed(false)}
          />
        ) : (
          <Section
            title="Playlist"
            icon={<ListPlus size={15} />}
            elastic
            className="min-w-0"
            onTitleClick={() => setPlCollapsed(true)}
          >
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <Playlist
                tracks={playlist}
                albumById={albumById}
                currentTrackId={current?.id ?? null}
                onPlayAt={playPlaylistAt}
                onRemove={removeFromPlaylist}
                onClear={clearPlaylist}
                onLoad={loadPlaylistFile}
                onSave={savePlaylistFile}
              />
            </div>
          </Section>
        )}

        {/* Now playing + queue */}
        {npCollapsed ? (
          <CollapsedStrip
            title="Now playing"
            icon={<Music size={15} />}
            onExpand={() => setNpCollapsed(false)}
          />
        ) : (
          <div className="flex flex-col gap-3 min-h-0 min-w-0">
            <Section
              title="Now playing"
              icon={<Music size={15} />}
              onTitleClick={() => setNpCollapsed(true)}
            >
              <NowPlaying track={current} album={currentAlbum} />
            </Section>
            <Section
              title="Queue"
              icon={<ListMusic size={15} />}
              elastic
              className="flex-1"
              onTitleClick={() => setNpCollapsed(true)}
            >
              <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <Queue queue={queue} index={index} onJump={setIndex} />
              </div>
            </Section>
          </div>
        )}

        {/* Video (scaffold — placeholder picture surface, last section) */}
        {vidCollapsed ? (
          <CollapsedStrip
            title="Video"
            icon={<Film size={15} />}
            onExpand={() => setVidCollapsed(false)}
          />
        ) : (
          <Section
            title="Video"
            icon={<Film size={15} />}
            elastic
            className="min-w-0"
            onTitleClick={() => setVidCollapsed(true)}
          >
            <Video
              track={current}
              album={currentAlbum}
              mediaBase={mediaBaseUrl}
              volume={volume}
              elRef={videoElRef}
            />
          </Section>
        )}
      </div>

      {/* Footer — now playing, seek, volume (transport is in the header) */}
      <PlayerBar
        track={current}
        album={currentAlbum}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        onSeek={seek}
        onVolume={changeVolume}
      />
    </div>
  );
}
