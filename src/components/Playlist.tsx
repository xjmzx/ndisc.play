import { FolderOpen, Play, Save, Trash2, X } from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import type { Album, Track } from "../lib/tauri";

interface PlaylistProps {
  tracks: Track[];
  albumById: Map<number, Album>;
  currentTrackId: number | null;
  /** Play the playlist starting at this index (loads it into the queue). */
  onPlayAt: (index: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  /** Import an .xspf into the playlist. */
  onLoad: () => void;
  /** Export the playlist as an .xspf. */
  onSave: () => void;
}

export function Playlist({
  tracks,
  albumById,
  currentTrackId,
  onPlayAt,
  onRemove,
  onClear,
  onLoad,
  onSave,
}: PlaylistProps) {
  return (
    <div className="flex flex-col gap-1">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 -mt-1 pt-1 bg-panel/95 flex items-center gap-2">
        <button
          onClick={() => onPlayAt(0)}
          disabled={!tracks.length}
          className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md bg-surface/70 hover:bg-surfaceHover disabled:opacity-40 transition-colors"
          title="Play playlist"
        >
          <Play size={13} /> Play
        </button>
        <button
          onClick={onLoad}
          title="Load an .xspf playlist"
          className="ml-auto text-muted hover:text-accent transition-colors"
        >
          <FolderOpen size={14} />
        </button>
        <button
          onClick={onSave}
          disabled={!tracks.length}
          title="Save as .xspf"
          className="text-muted hover:text-accent disabled:opacity-40 transition-colors"
        >
          <Save size={14} />
        </button>
        <span className="text-[11px] text-muted tabular-nums">
          {tracks.length}
        </span>
        <button
          onClick={onClear}
          disabled={!tracks.length}
          title="Clear playlist"
          className="text-muted hover:text-alert disabled:opacity-40 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {!tracks.length ? (
        <div className="text-[13px] text-muted px-1 py-2">
          Empty. Add tracks from the Collection with the{" "}
          <span className="text-fg/70">+</span> button.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {tracks.map((t, i) => {
            const active = t.id === currentTrackId;
            const artist = albumById.get(t.albumId)?.artist ?? "";
            return (
              <div
                key={`${t.id}-${i}`}
                className={cn(
                  "group flex items-center gap-2 px-2 py-1 rounded hover:bg-surface/50 text-[13px]",
                  active && "bg-surface/70",
                )}
              >
                <button
                  onClick={() => onPlayAt(i)}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                >
                  <span className="w-4 text-right text-[11px] text-muted tabular-nums shrink-0">
                    {i + 1}
                  </span>
                  <span className="truncate min-w-0">
                    <span className={active ? "text-accent" : "text-fg/80"}>
                      {t.title}
                    </span>
                    {artist && <span className="text-muted"> · {artist}</span>}
                  </span>
                </button>
                {t.duration != null && (
                  <span className="text-[11px] text-muted tabular-nums shrink-0">
                    {formatTime(t.duration)}
                  </span>
                )}
                <button
                  onClick={() => onRemove(i)}
                  title="Remove"
                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-alert shrink-0 transition-opacity"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
