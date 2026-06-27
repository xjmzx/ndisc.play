import { Music2 } from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/tauri";

interface QueueProps {
  queue: Track[];
  index: number;
  onJump: (i: number) => void;
}

export function Queue({ queue, index, onJump }: QueueProps) {
  if (!queue.length) {
    return (
      <div className="text-[13px] text-muted px-1 py-2">
        Queue is empty. Pick a track or album to start.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {queue.map((t, i) => {
        const active = i === index;
        return (
          <button
            key={`${t.id}-${i}`}
            onClick={() => onJump(i)}
            className={cn(
              "flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-surface/50 text-[13px]",
              active && "bg-surface/70",
            )}
          >
            {active ? (
              <Music2 size={12} className="text-accent shrink-0" />
            ) : (
              <span className="w-4 text-right text-[11px] text-muted tabular-nums shrink-0">
                {i + 1}
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
            {t.duration != null && (
              <span className="text-[11px] text-muted tabular-nums shrink-0">
                {formatTime(t.duration)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
