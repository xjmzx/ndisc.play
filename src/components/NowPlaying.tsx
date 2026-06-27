import { useState } from "react";
import { Music4 } from "lucide-react";
import { fileSrc, type Album, type Track } from "../lib/tauri";

interface NowPlayingProps {
  track: Track | null;
  album: Album | null;
}

export function NowPlaying({ track, album }: NowPlayingProps) {
  // Reset the broken-image flag whenever the cover source changes.
  const cover = album?.coverPath ?? null;
  const [errored, setErrored] = useState<string | null>(null);
  const showImage = cover && errored !== cover;

  const meta: string[] = [];
  if (track?.codec) meta.push(track.codec);
  if (track?.sampleRate) meta.push(`${(track.sampleRate / 1000).toFixed(1)} kHz`);
  if (track?.bitDepth) meta.push(`${track.bitDepth}-bit`);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-full aspect-square rounded-xl bg-surface/40 border border-surface/60 overflow-hidden flex items-center justify-center shadow-inner">
        {showImage ? (
          <img
            src={fileSrc(cover)}
            alt={album?.album ?? ""}
            className="w-full h-full object-cover"
            onError={() => setErrored(cover)}
          />
        ) : (
          <Music4 size={64} className="text-muted/40" strokeWidth={1.2} />
        )}
      </div>

      {track ? (
        <div className="w-full text-center px-1">
          <div className="font-medium text-fg truncate" title={track.title}>
            {track.title}
          </div>
          <div className="text-sm text-fg/70 truncate" title={album?.artist}>
            {album?.artist ?? ""}
          </div>
          <div className="text-[13px] text-muted truncate">
            {album?.album}
            {album?.year != null ? ` · ${album.year}` : ""}
          </div>
          {meta.length > 0 && (
            <div className="mt-1 text-[11px] text-muted/80 tabular-nums">
              {meta.join("  ·  ")}
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-muted">Nothing playing</div>
      )}
    </div>
  );
}
