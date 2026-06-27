import { Volume2 } from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import type { Album, Track } from "../lib/tauri";

interface PlayerBarProps {
  track: Track | null;
  album: Album | null;
  currentTime: number;
  duration: number;
  volume: number;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
}

// Transport (prev/play/next) lives in the header now; the footer is just the
// centered now-playing title, seek bar, time readouts and volume.
export function PlayerBar({
  track,
  album,
  currentTime,
  duration,
  volume,
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
    <div className="flex justify-center px-4 py-2.5 bg-panel border-t border-surface/60">
      <div className="w-1/2 min-w-[300px] max-w-full flex flex-col items-center gap-1">
        {/* Title */}
        <div className="flex items-center justify-center gap-2 text-[13px] min-w-0 max-w-full">
          <span className="truncate text-fg/90">{track?.title ?? "—"}</span>
          {album && (
            <span className="truncate text-muted shrink-[2]">{album.artist}</span>
          )}
        </div>

        {/* Elapsed · seek · total · volume */}
        <div className="w-full flex items-center gap-2">
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
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] text-muted font-mono tabular-nums w-9 shrink-0">
            {formatTime(duration)}
          </span>
          <Volume2 size={15} className="text-muted shrink-0 ml-1" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onVolume(parseFloat(e.target.value))}
            title="Volume"
            className={cn(
              "w-24 cursor-pointer shrink-0 appearance-none bg-transparent",
              // visible track
              "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surfaceHover",
              // accent thumb, centered on the thin track
              "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:-mt-[3px]",
            )}
          />
        </div>
      </div>
    </div>
  );
}
