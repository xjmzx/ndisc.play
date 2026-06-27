import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import type { Album, Track } from "../lib/tauri";

interface PlayerBarProps {
  track: Track | null;
  album: Album | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  canPrev: boolean;
  canNext: boolean;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
}

export function PlayerBar({
  track,
  album,
  isPlaying,
  currentTime,
  duration,
  volume,
  canPrev,
  canNext,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onVolume,
}: PlayerBarProps) {
  function seek(e: React.MouseEvent<HTMLDivElement>) {
    if (!duration || !isFinite(duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(pct * duration);
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 bg-panel border-t border-surface/60">
      {/* Transport buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onPrev}
          disabled={!canPrev}
          title="Previous"
          className="text-fg/80 hover:text-accent disabled:text-muted/40 disabled:hover:text-muted/40 transition-colors"
        >
          <SkipBack size={18} />
        </button>
        <button
          onClick={onToggle}
          disabled={!track}
          title={isPlaying ? "Pause" : "Play"}
          className="w-9 h-9 rounded-full bg-surface/70 hover:bg-surfaceHover flex items-center justify-center text-fg disabled:text-muted/40 transition-colors"
        >
          {isPlaying ? (
            <Pause size={18} />
          ) : (
            <Play size={18} className="translate-x-[1px]" />
          )}
        </button>
        <button
          onClick={onNext}
          disabled={!canNext}
          title="Next"
          className="text-fg/80 hover:text-accent disabled:text-muted/40 disabled:hover:text-muted/40 transition-colors"
        >
          <SkipForward size={18} />
        </button>
      </div>

      {/* Title + seek */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-[13px] min-w-0">
          <span className="truncate text-fg/90">
            {track?.title ?? "—"}
          </span>
          {album && (
            <span className="truncate text-muted shrink-[2]">
              {album.artist}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted font-mono tabular-nums w-9 text-right shrink-0">
            {formatTime(currentTime)}
          </span>
          <div
            onClick={seek}
            className={cn(
              "flex-1 h-1.5 rounded-full bg-surface/60 overflow-hidden relative min-w-0",
              track ? "cursor-pointer" : "cursor-default",
            )}
            title="Click to seek"
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] text-muted font-mono tabular-nums w-9 shrink-0">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 shrink-0 w-32">
        <Volume2 size={16} className="text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="flex-1 accent-accent h-1 cursor-pointer"
          title="Volume"
        />
      </div>
    </div>
  );
}
