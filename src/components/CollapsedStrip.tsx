import { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

interface CollapsedStripProps {
  title: string;
  icon?: ReactNode;
  onExpand: () => void;
}

/** A collapsed panel rendered as a narrow vertical sliver — the whole
 *  strip is the expand button (matches ndisc.tree / ndisc.smpl). */
export function CollapsedStrip({ title, icon, onExpand }: CollapsedStripProps) {
  return (
    <button
      onClick={onExpand}
      title={`Expand ${title}`}
      aria-label={`Expand ${title}`}
      className="h-full w-full rounded-xl bg-panel border border-surface/60 shadow-md
                 flex flex-col items-center gap-2 py-3
                 text-accent hover:bg-surface/30 transition-colors"
    >
      <ChevronRight size={14} className="text-muted shrink-0" />
      {icon}
      <span className="text-[11px] tracking-wide uppercase [writing-mode:vertical-rl]">
        {title}
      </span>
    </button>
  );
}
