import { useState, type RefObject } from "react";
import { Film } from "lucide-react";
import { videoSrc, type Album, type Track } from "../lib/tauri";

interface VideoProps {
  /** Current track — an mp4 gets a real <video> surface; else a placeholder. */
  track: Track | null;
  album: Album | null;
  /** Loopback media-server base URL (http://127.0.0.1:<port>). */
  mediaBase: string;
  /** Current app volume (0..1) — applied to the element on load. */
  volume: number;
  /** Shared handle so the app transport (header/footer) can drive playback. */
  elRef: RefObject<HTMLVideoElement | null>;
}

// mp4 + m4v both play with picture (h264/aac/ac3 via WebKit2GTK+libav over the
// loopback server); other containers are audio-only until remuxed.
const isPlayableVideo = (p: string) => /\.(mp4|m4v)$/i.test(p);

/**
 * VIDEO — the 4th section. mp4 plays in a webview <video> element streamed
 * from the Rust loopback server (WebKit2GTK can't play local media over the
 * asset protocol). The element is shared up via `elRef` so the app's
 * header/footer transport drives it (App routes video tracks here instead of
 * rodio). Non-mp4 videos stay audio-only (rodio) and show the placeholder;
 * a non-conforming mp4 that won't decode shows a note.
 */
export function Video({ track, mediaBase, volume, elRef }: VideoProps) {
  const [error, setError] = useState(false);
  const playable = !!track?.isVideo && isPlayableVideo(track.path) && !!mediaBase;

  if (playable) {
    return (
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        <video
          key={track!.path}
          ref={elRef}
          src={videoSrc(mediaBase, track!.path)}
          controls
          autoPlay
          onLoadStart={(e) => {
            setError(false);
            e.currentTarget.volume = volume;
          }}
          onError={() => setError(true)}
          className="w-full aspect-video rounded-md bg-black"
        />
        {error && (
          <p className="text-[11px] px-1 leading-relaxed text-alert">
            This mp4 won’t decode (non-conforming / unsupported profile).
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="relative aspect-video w-full rounded-md bg-bg/60 border border-surface/40 flex items-center justify-center overflow-hidden">
        <Film size={28} className="text-muted/40" />
      </div>
      <p className="text-[12px] text-muted px-1 leading-relaxed">
        {track?.isVideo
          ? "Non-mp4 video — playing audio only. Convert to mp4 for picture."
          : "No video playing. Use the Video filter to find clips, then double-click one."}
      </p>
    </div>
  );
}
