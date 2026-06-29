import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import {
  listAllTracks,
  setTrackField,
  type FlatTrack,
  type Track,
} from "../lib/tauri";

// Flat, sortable, read-only view of the whole library — the hierarchically-flat
// counterpart to the Collection tree (ndisc's BatchEditView skeleton). A track's
// metadata comes from file tags; inline tag-editing is a planned follow-up, so
// this first cut is read-only. Double-click a row to play from there.

type SortKey =
  | "artist"
  | "album"
  | "trackNo"
  | "title"
  | "duration"
  | "codec"
  | "sampleRate"
  | "playable";
type SortDir = "asc" | "desc";

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
  /** Editable tag field written back to the file (title / trackNo). */
  field?: "title" | "trackNo";
}

const COLUMNS: Column[] = [
  { key: "artist", label: "artist" },
  { key: "album", label: "album" },
  { key: "trackNo", label: "#", numeric: true, field: "trackNo" },
  { key: "title", label: "title", field: "title" },
  { key: "duration", label: "time", numeric: true },
  { key: "codec", label: "codec" },
  { key: "sampleRate", label: "kHz", numeric: true },
  { key: "playable", label: "ok" },
];

const GRID =
  "grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_2.5rem_minmax(0,1.4fr)_3.5rem_4rem_3.5rem_2rem]";

// Rendered-row cap (sorted first) so a large library stays responsive without
// virtualization; overflow is surfaced in the toolbar, never silently dropped.
const MAX_ROWS = 2000;

function val(t: FlatTrack, key: SortKey): string | number | null | undefined {
  if (key === "playable") return t.playable ? 1 : 0;
  return t[key] as string | number | null | undefined;
}

function compare(a: FlatTrack, b: FlatTrack, key: SortKey, dir: SortDir, numeric: boolean) {
  const av = val(a, key);
  const bv = val(b, key);
  const aEmpty = av == null || av === "";
  const bEmpty = bv == null || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // blanks always sink
  if (bEmpty) return -1;
  const r = numeric
    ? Number(av) - Number(bv)
    : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
  return dir === "asc" ? r : -r;
}

const khz = (sr: number | null) =>
  sr == null ? "—" : String(parseFloat((sr / 1000).toFixed(1)));

export function TableView({
  reloadKey,
  currentTrackId,
  onPlay,
}: {
  /** Bump to reload after a scan. */
  reloadKey: number;
  currentTrackId: number | null;
  /** Play the (sorted) list starting at the double-clicked row. */
  onPlay: (tracks: Track[], startIndex: number) => void;
}) {
  const [rows, setRows] = useState<FlatTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAllTracks()
      .then((r) => !cancelled && setRows(r))
      .catch(() => !cancelled && setRows([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const sorted = useMemo(() => {
    const numeric = !!COLUMNS.find((c) => c.key === sortKey)?.numeric || sortKey === "playable";
    return [...rows].sort((a, b) => compare(a, b, sortKey, sortDir, numeric));
  }, [rows, sortKey, sortDir]);

  const shown = sorted.slice(0, MAX_ROWS);
  const overflow = sorted.length - shown.length;

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div className="rounded-xl bg-panel border border-surface/60 shadow-md flex flex-col min-h-0 h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-1.5 shrink-0 border-b border-surface/60 text-xs">
        <span className="text-muted">
          {loading ? "loading…" : `${rows.length} tracks`}
          {overflow > 0 && (
            <span className="ml-3 text-auburn">
              showing {MAX_ROWS} of {rows.length} (sorted) — narrow to see the
              rest
            </span>
          )}
          <span className="ml-3 text-muted/60">double-click a row to play</span>
        </span>
      </div>

      <div
        className={cn(
          "grid items-center gap-3 px-4 py-2 shrink-0 border-b border-surface/60",
          "bg-panel sticky top-0 z-10 text-xs uppercase tracking-wide text-accent font-medium",
          GRID,
        )}
      >
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => toggleSort(c.key)}
            className={cn(
              "inline-flex items-center gap-1 min-w-0 hover:text-fg transition-colors",
              c.numeric || c.key === "playable" ? "justify-end" : "justify-start",
            )}
            title={`Sort by ${c.label}`}
          >
            <span className="truncate">{c.label}</span>
            {sortKey === c.key &&
              (sortDir === "asc" ? (
                <ArrowUp size={11} className="shrink-0" />
              ) : (
                <ArrowDown size={11} className="shrink-0" />
              ))}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted">loading…</div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted">
            No tracks — scan a library to get started.
          </div>
        ) : (
          shown.map((t, i) => {
            const active = t.id === currentTrackId;
            const unplayable = t.playable === false;
            return (
              <div
                key={t.id}
                onDoubleClick={() => onPlay(sorted, i)}
                title={unplayable ? `${t.codec ?? "format"} can't be decoded` : undefined}
                className={cn(
                  "grid items-center gap-3 px-4 py-1 font-mono text-xs select-none cursor-default",
                  "border-b border-fg/15 hover:bg-surface/30 transition-colors",
                  active && "bg-surface/70",
                  GRID,
                )}
              >
                {COLUMNS.map((c) => {
                  if (c.key === "playable") {
                    return (
                      <span
                        key={c.key}
                        className={cn(
                          "w-2 h-2 rounded-full justify-self-end shrink-0",
                          unplayable ? "bg-auburn" : "bg-ok/70",
                        )}
                        title={unplayable ? "can't be decoded" : "playable"}
                      />
                    );
                  }
                  if (c.field) {
                    const cur =
                      c.field === "title"
                        ? t.title
                        : t.trackNo == null
                          ? ""
                          : String(t.trackNo);
                    const field = c.field;
                    return (
                      <Cell
                        key={c.key}
                        value={cur}
                        numeric={c.numeric}
                        onCommit={async (next) => {
                          await setTrackField(t.id, t.path, field, next);
                          setRows((rs) =>
                            rs.map((r) =>
                              r.id === t.id
                                ? field === "title"
                                  ? { ...r, title: next ?? r.title }
                                  : {
                                      ...r,
                                      trackNo: next == null ? null : Number(next),
                                    }
                                : r,
                            ),
                          );
                        }}
                      />
                    );
                  }
                  const raw = t[c.key as keyof FlatTrack] as
                    | string
                    | number
                    | null
                    | undefined;
                  const empty = raw == null || raw === "";
                  const text =
                    c.key === "duration"
                      ? t.duration != null
                        ? formatTime(t.duration)
                        : "—"
                      : c.key === "sampleRate"
                        ? khz(t.sampleRate)
                        : empty
                          ? "—"
                          : String(raw);
                  return (
                    <span
                      key={c.key}
                      className={cn(
                        "truncate text-fg/85",
                        c.numeric && "text-right tabular-nums",
                        empty && c.key !== "sampleRate" && "text-muted/40",
                      )}
                      title={empty ? undefined : String(raw)}
                    >
                      {text}
                    </span>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Inline-editable cell: click to edit, commit on blur/Enter, revert on Escape.
// Stops click/double-click from bubbling so editing never fires the row's
// double-click-to-play. (Ported from ndisc's BatchEditView, trimmed.)
function Cell({
  value,
  numeric,
  onCommit,
}: {
  value: string;
  numeric?: boolean;
  onCommit: (next: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  async function commit() {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if ((value || null) === next) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(next);
      setEditing(false);
    } catch {
      setDraft(value); // write failed — restore the prior value
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={draft}
        disabled={saving}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        spellCheck={false}
        className={cn(
          "w-full h-6 px-1.5 rounded bg-surface text-fg outline-none border border-accent/50 text-xs disabled:opacity-50",
          numeric && "text-right tabular-nums",
        )}
      />
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "group h-6 flex items-center gap-1 rounded min-w-0 border border-transparent hover:border-accent/40 hover:bg-surface/70 transition-colors",
        numeric && "justify-end",
      )}
    >
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={value ? value : "Set value"}
        disabled={saving}
        className={cn(
          "flex-1 h-full inline-flex items-center gap-1.5 px-1.5 min-w-0 disabled:opacity-50",
          numeric ? "justify-end" : "justify-between",
        )}
      >
        <span
          className={cn(
            "truncate",
            numeric && "tabular-nums",
            value ? "text-fg/85" : "text-muted/40",
          )}
        >
          {value || "—"}
        </span>
        <Pencil
          size={9}
          className="shrink-0 text-muted/30 group-hover:text-accent transition-colors"
        />
      </button>
    </div>
  );
}
