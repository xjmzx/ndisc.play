import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  ListMusic,
  Loader2,
  Music,
  RefreshCw,
} from "lucide-react";
import { Section } from "./components/Section";
import { LibraryTree } from "./components/LibraryTree";
import { NowPlaying } from "./components/NowPlaying";
import { PlayerBar } from "./components/PlayerBar";
import { Queue } from "./components/Queue";
import {
  audioPause,
  audioPlay,
  audioResume,
  audioSeek,
  audioSetVolume,
  audioStatus,
  audioStop,
  getConfig,
  listAlbums,
  onScanProgress,
  scanLibrary,
  setMusicRoot,
  type Album,
  type ScanProgress,
  type Track,
} from "./lib/tauri";

export default function App() {
  const [musicRoot, setRoot] = useState("");
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loadingAlbums, setLoadingAlbums] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  const current = index >= 0 && index < queue.length ? queue[index] : null;

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
    refreshAlbums();
    const un = onScanProgress(setProgress);
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function doScan() {
    setScanning(true);
    setProgress({ phase: "walk", done: 0, total: 0 });
    try {
      await scanLibrary();
      await refreshAlbums();
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
  // Latest next handler held in a ref so the status poll never closes over
  // stale queue/index state.
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

  function toggle() {
    if (!current) return;
    if (isPlaying) {
      setIsPlaying(false);
      audioPause().catch(() => {});
    } else {
      setIsPlaying(true);
      audioResume().catch(() => {});
    }
  }

  function prev() {
    if (currentTime > 3) {
      audioSeek(0).catch(() => {});
      setCurrentTime(0);
      return;
    }
    if (index > 0) setIndex(index - 1);
    else {
      audioSeek(0).catch(() => {});
      setCurrentTime(0);
    }
  }

  function seek(t: number) {
    audioSeek(t).catch(() => {});
    setCurrentTime(t);
  }

  function changeVolume(v: number) {
    setVolume(v);
    audioSetVolume(v).catch(() => {});
  }

  // Start playback whenever the current track changes.
  useEffect(() => {
    if (!current) return;
    setCurrentTime(0);
    setDuration(current.duration ?? 0);
    setIsPlaying(true);
    audioPlay(current.path).catch((e) => console.error("play failed", e));
    audioSetVolume(volume).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Poll the backend for position / finished while a track is loaded.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const s = await audioStatus();
        if (!alive) return;
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
  const canPrev = queue.length > 0;

  const albumCount = albums.length;
  const scanLabel =
    progress && progress.phase === "read" && progress.total
      ? `${Math.round((progress.done / progress.total) * 100)}%`
      : progress?.phase === "walk"
        ? "scanning…"
        : "";

  return (
    <div className="h-full flex flex-col bg-bg text-fg">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-surface/60 bg-panel/60">
        <Music size={18} className="text-accent shrink-0" />
        <h1 className="text-sm font-semibold tracking-wide">
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
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {scanLabel && (
            <span className="text-[12px] text-muted tabular-nums">
              {scanLabel}
            </span>
          )}
          <span className="text-[12px] text-muted">
            {albumCount} albums
          </span>
          <button
            onClick={doScan}
            disabled={scanning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-surface/70 hover:bg-surfaceHover disabled:opacity-50 transition-colors"
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

      {/* Main */}
      <div className="flex-1 min-h-0 flex gap-3 p-3">
        {/* Collection */}
        <Section
          title="Collection"
          icon={<ListMusic size={15} />}
          elastic
          className="flex-1 min-w-0"
        >
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
              />
            )}
          </div>
        </Section>

        {/* Right column: now playing + queue */}
        <div className="w-[320px] shrink-0 flex flex-col gap-3 min-h-0">
          <Section title="Now playing" icon={<Music size={15} />}>
            <NowPlaying track={current} album={currentAlbum} />
          </Section>
          <Section
            title="Queue"
            icon={<ListMusic size={15} />}
            elastic
            className="flex-1"
          >
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <Queue queue={queue} index={index} onJump={setIndex} />
            </div>
          </Section>
        </div>
      </div>

      {/* Transport */}
      <PlayerBar
        track={current}
        album={currentAlbum}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        canPrev={canPrev}
        canNext={canNext}
        onToggle={toggle}
        onPrev={prev}
        onNext={() => nextRef.current()}
        onSeek={seek}
        onVolume={changeVolume}
      />
    </div>
  );
}
