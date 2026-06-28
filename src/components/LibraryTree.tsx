import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Film,
  Music2,
  Play,
  Plus,
} from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { listAlbumTracks, type Album, type Track } from "../lib/tauri";

export type SortKey = "artist" | "album" | "year";

/** mp4 is the format that actually plays with picture (others are audio-only). */
const isMp4 = (p: string) => /\.mp4$/i.test(p);

interface LibraryTreeProps {
  albums: Album[];
  /** Id of the track currently loaded in the transport (for highlight). */
  currentTrackId: number | null;
  /** Play `tracks` starting at `startIndex` (replaces the queue). */
  onPlay: (tracks: Track[], startIndex: number) => void;
  /** Append tracks to the playlist. */
  onAddToPlaylist: (tracks: Track[]) => void;
  /** Album ordering within each artist. */
  sort: SortKey;
  /** Substring filter over artist + album names (case-insensitive). */
  filter: string;
  /** Restrict to albums that contain video, and show only their video tracks. */
  videoOnly: boolean;
}

interface ArtistGroup {
  artist: string;
  albums: Album[];
}

export function LibraryTree({
  albums,
  currentTrackId,
  onPlay,
  onAddToPlaylist,
  sort,
  filter,
  videoOnly,
}: LibraryTreeProps) {
  // Group by artist (backend already sorts by artist, year, album), then
  // re-order each group's albums by the chosen sort and apply the filter.
  const groups = useMemo<ArtistGroup[]>(() => {
    const source = videoOnly ? albums.filter((a) => a.hasVideo) : albums;
    const out: ArtistGroup[] = [];
    let last: ArtistGroup | null = null;
    for (const a of source) {
      if (!last || last.artist !== a.artist) {
        last = { artist: a.artist, albums: [] };
        out.push(last);
      }
      last.albums.push(a);
    }

    const byAlbum = (x: Album, y: Album) =>
      x.album.toLowerCase().localeCompare(y.album.toLowerCase());
    for (const g of out) {
      if (sort === "album") {
        g.albums = [...g.albums].sort(byAlbum);
      } else if (sort === "year") {
        g.albums = [...g.albums].sort(
          (x, y) => (x.year ?? Infinity) - (y.year ?? Infinity) || byAlbum(x, y),
        );
      }
      // "artist" keeps the backend (year, album) order.
    }

    const f = filter.trim().toLowerCase();
    if (!f) return out;
    return out
      .map((g) => {
        if (g.artist.toLowerCase().includes(f)) return g;
        const albums = g.albums.filter((al) =>
          al.album.toLowerCase().includes(f),
        );
        return albums.length ? { artist: g.artist, albums } : null;
      })
      .filter((g): g is ArtistGroup => g !== null);
  }, [albums, sort, filter, videoOnly]);

  // Auto-expand artists when narrowing (text filter or video-only) so the
  // (usually few) matches are visible without manual drilling.
  const filtering = filter.trim().length > 0 || videoOnly;

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

  async function addAlbum(albumId: number) {
    const rows = await ensureTracks(albumId);
    if (rows.length) onAddToPlaylist(rows);
  }

  if (!albums.length) {
    return (
      <div className="text-sm text-muted px-2 py-4">
        No albums indexed yet. Scan your library to get started.
      </div>
    );
  }

  if (!groups.length) {
    return (
      <div className="text-sm text-muted px-2 py-4">No matches.</div>
    );
  }

  return (
    <div className="text-sm">
      {groups.map((g) => {
        // While filtering, show matching groups expanded so hits are visible.
        const artistOpen = filtering || openArtists.has(g.artist);
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
              <span className="truncate min-w-0 rounded-full px-2 py-0.5 bg-mauve/15 text-mauve font-medium">
                {g.artist}
              </span>
              <span className="ml-auto text-[11px] text-muted tabular-nums shrink-0">
                {g.albums.length}
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
                          <span className="truncate min-w-0 rounded-full px-2 py-0.5 bg-digital/15 text-digital">
                            {al.album}
                          </span>
                          {al.year != null && (
                            <span className="text-[11px] text-muted shrink-0">
                              {al.year}
                            </span>
                          )}
                          {al.hasVideo && (
                            <Film size={12} className="text-mauve/70 shrink-0" />
                          )}
                        </button>
                        <button
                          onClick={() => playAlbum(al.id, 0)}
                          title="Play album"
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent shrink-0 transition-opacity"
                        >
                          <Play size={13} />
                        </button>
                        <button
                          onClick={() => addAlbum(al.id)}
                          title="Add album to playlist"
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent shrink-0 transition-opacity"
                        >
                          <Plus size={13} />
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
                          {(videoOnly
                            ? tracks.filter((t) => t.isVideo)
                            : tracks
                          ).map((t, i, shown) => {
                            const active = t.id === currentTrackId;
                            const playableVideo = t.isVideo && isMp4(t.path);
                            return (
                              <div
                                key={t.id}
                                className={cn(
                                  "group flex items-center gap-2 px-2 py-1 rounded hover:bg-surface/50",
                                  active && "bg-surface/70",
                                )}
                              >
                                <button
                                  onDoubleClick={() => onPlay(shown, i)}
                                  title="Double-click to play"
                                  className="flex items-center gap-2 min-w-0 flex-1 text-left select-none"
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
                                      active
                                        ? "text-accent"
                                        : playableVideo
                                          ? "text-digital"
                                          : "text-fg/75",
                                    )}
                                  >
                                    {t.title}
                                  </span>
                                </button>
                                {t.isVideo && (
                                  <Film
                                    size={11}
                                    className={cn(
                                      "shrink-0",
                                      playableVideo
                                        ? "text-digital"
                                        : "text-mauve/60",
                                    )}
                                  />
                                )}
                                {t.duration != null && (
                                  <span className="text-[11px] text-muted tabular-nums shrink-0">
                                    {formatTime(t.duration)}
                                  </span>
                                )}
                                <button
                                  onClick={() => onAddToPlaylist([t])}
                                  title="Add to playlist"
                                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent shrink-0 transition-opacity"
                                >
                                  <Plus size={13} />
                                </button>
                              </div>
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
