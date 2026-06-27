import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Disc3,
  Film,
  Music2,
  Play,
} from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { listAlbumTracks, type Album, type Track } from "../lib/tauri";

interface LibraryTreeProps {
  albums: Album[];
  /** Id of the track currently loaded in the transport (for highlight). */
  currentTrackId: number | null;
  /** Play `tracks` starting at `startIndex` (replaces the queue). */
  onPlay: (tracks: Track[], startIndex: number) => void;
}

interface ArtistGroup {
  artist: string;
  albums: Album[];
}

export function LibraryTree({
  albums,
  currentTrackId,
  onPlay,
}: LibraryTreeProps) {
  // Backend already sorts albums by (artist, year, album); preserve that
  // order while grouping into artists.
  const groups = useMemo<ArtistGroup[]>(() => {
    const out: ArtistGroup[] = [];
    let last: ArtistGroup | null = null;
    for (const a of albums) {
      if (!last || last.artist !== a.artist) {
        last = { artist: a.artist, albums: [] };
        out.push(last);
      }
      last.albums.push(a);
    }
    return out;
  }, [albums]);

  const [openArtists, setOpenArtists] = useState<Set<string>>(new Set());
  const [openAlbums, setOpenAlbums] = useState<Set<number>>(new Set());
  const [trackCache, setTrackCache] = useState<Record<number, Track[]>>({});
  const [loading, setLoading] = useState<Set<number>>(new Set());

  function toggleArtist(name: string) {
    setOpenArtists((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  async function ensureTracks(albumId: number): Promise<Track[]> {
    if (trackCache[albumId]) return trackCache[albumId];
    setLoading((p) => new Set(p).add(albumId));
    try {
      const rows = await listAlbumTracks(albumId);
      setTrackCache((p) => ({ ...p, [albumId]: rows }));
      return rows;
    } finally {
      setLoading((p) => {
        const n = new Set(p);
        n.delete(albumId);
        return n;
      });
    }
  }

  async function toggleAlbum(albumId: number) {
    const isOpen = openAlbums.has(albumId);
    if (!isOpen) await ensureTracks(albumId);
    setOpenAlbums((prev) => {
      const next = new Set(prev);
      next.has(albumId) ? next.delete(albumId) : next.add(albumId);
      return next;
    });
  }

  async function playAlbum(albumId: number, startIndex = 0) {
    const rows = await ensureTracks(albumId);
    if (rows.length) onPlay(rows, startIndex);
  }

  if (!albums.length) {
    return (
      <div className="text-sm text-muted px-2 py-4">
        No albums indexed yet. Scan your library to get started.
      </div>
    );
  }

  return (
    <div className="text-sm">
      {groups.map((g) => {
        const artistOpen = openArtists.has(g.artist);
        const albumCount = g.albums.length;
        return (
          <div key={g.artist}>
            <button
              onClick={() => toggleArtist(g.artist)}
              className="w-full flex items-center gap-1.5 px-1 py-1 rounded hover:bg-surface/50 text-left"
            >
              {artistOpen ? (
                <ChevronDown size={14} className="text-muted shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-muted shrink-0" />
              )}
              <span className="truncate font-medium text-fg/90">
                {g.artist}
              </span>
              <span className="ml-auto text-[11px] text-muted tabular-nums shrink-0">
                {albumCount}
              </span>
            </button>

            {artistOpen && (
              <div className="ml-3 border-l border-surface/40 pl-1">
                {g.albums.map((al) => {
                  const albumOpen = openAlbums.has(al.id);
                  const tracks = trackCache[al.id] ?? [];
                  const isLoading = loading.has(al.id);
                  return (
                    <div key={al.id}>
                      <div className="group flex items-center gap-1.5 px-1 py-1 rounded hover:bg-surface/50">
                        <button
                          onClick={() => toggleAlbum(al.id)}
                          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                        >
                          {albumOpen ? (
                            <ChevronDown
                              size={13}
                              className="text-muted shrink-0"
                            />
                          ) : (
                            <ChevronRight
                              size={13}
                              className="text-muted shrink-0"
                            />
                          )}
                          <Disc3
                            size={13}
                            className="text-digital/70 shrink-0"
                          />
                          <span className="truncate text-fg/80">
                            {al.album}
                          </span>
                          {al.year != null && (
                            <span className="text-[11px] text-muted shrink-0">
                              {al.year}
                            </span>
                          )}
                          {al.hasVideo && (
                            <Film
                              size={12}
                              className="text-mauve/70 shrink-0"
                            />
                          )}
                        </button>
                        <button
                          onClick={() => playAlbum(al.id, 0)}
                          title="Play album"
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent shrink-0 transition-opacity"
                        >
                          <Play size={13} />
                        </button>
                        <span className="text-[11px] text-muted tabular-nums shrink-0 w-5 text-right">
                          {al.trackCount}
                        </span>
                      </div>

                      {albumOpen && (
                        <div className="ml-5 border-l border-surface/30 pl-1">
                          {isLoading && (
                            <div className="px-2 py-1 text-[11px] text-muted">
                              loading…
                            </div>
                          )}
                          {tracks.map((t, i) => {
                            const active = t.id === currentTrackId;
                            return (
                              <button
                                key={t.id}
                                onDoubleClick={() => onPlay(tracks, i)}
                                onClick={() => onPlay(tracks, i)}
                                className={cn(
                                  "w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-surface/50",
                                  active && "bg-surface/70",
                                )}
                              >
                                {active ? (
                                  <Music2
                                    size={12}
                                    className="text-accent shrink-0"
                                  />
                                ) : (
                                  <span className="w-4 text-right text-[11px] text-muted tabular-nums shrink-0">
                                    {t.trackNo ?? "·"}
                                  </span>
                                )}
                                <span
                                  className={cn(
                                    "truncate flex-1",
                                    active ? "text-accent" : "text-fg/75",
                                  )}
                                >
                                  {t.title}
                                </span>
                                {t.isVideo && (
                                  <Film
                                    size={11}
                                    className="text-mauve/70 shrink-0"
                                  />
                                )}
                                {t.duration != null && (
                                  <span className="text-[11px] text-muted tabular-nums shrink-0">
                                    {formatTime(t.duration)}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
