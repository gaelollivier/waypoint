import { useEffect, useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Link } from "../components/Router";
import { formatBytes, formatDate } from "../lib/format";
import type {
  ComparisonBatchDetail,
  ComparisonKind,
  EncodingComparisonFrame,
  ComparisonMember,
  ComparisonSide,
  ComparisonVerdict,
} from "../api/types";

// Browser-side media kind detection. The streaming endpoint sets the right
// MIME type, but the kind decides which element we render.
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff",
  "heic", "heif", "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "3gp"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "wav", "aac", "flac", "ogg"]);

type MediaKind = "image" | "video" | "audio" | "other";
type ViewMode = "side-by-side" | "toggle";
type ActiveSide = "left" | "right";

function mediaKind(path: string): MediaKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "other";
}

function sideLabel(side: ActiveSide) {
  return side === "left" ? "A" : "B";
}

function swapSide(side: ActiveSide): ActiveSide {
  return side === "left" ? "right" : "left";
}

function ViewModeControl({
  mode,
  onModeChange,
}: {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}) {
  const button = (nextMode: ViewMode, label: string) => {
    const active = mode === nextMode;
    return (
      <button
        type="button"
        onClick={() => onModeChange(nextMode)}
        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
          active
            ? "bg-zinc-200 text-zinc-950"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="inline-flex overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
      {button("side-by-side", "Side by side")}
      {button("toggle", "Toggle A/B")}
    </div>
  );
}

function MediaPanel({
  side,
  label,
  immersive = false,
  onActivate,
}: {
  side: ComparisonSide;
  label: string;
  immersive?: boolean;
  onActivate?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const kind = mediaKind(side.path);
  const streamUrl = api.comparisons.mediaUrl(side.path);
  const downloadUrl = api.comparisons.mediaUrl(side.path, { download: true });

  // Reset error state when the source path changes (prev/next nav).
  useEffect(() => { setErrored(false); }, [side.path]);

  const maxHeight = immersive ? "max-h-[calc(100vh-18rem)]" : "max-h-[70vh]";

  return (
    <div className="min-w-0 flex flex-col gap-3">
      <div
        role={onActivate ? "button" : undefined}
        tabIndex={onActivate ? 0 : undefined}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (!onActivate) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
        aria-label={onActivate ? `Show ${label === "A" ? "B" : "A"}` : undefined}
        className={`relative min-h-0 rounded-md border border-zinc-800 bg-black overflow-hidden flex items-center justify-center ${
          immersive ? "h-[calc(100vh-18rem)] min-h-[360px]" : "min-h-[320px] lg:min-h-[520px]"
        } ${onActivate ? "cursor-pointer select-none" : ""}`}
      >
        <div className="absolute left-3 top-3 z-10 rounded bg-black/80 px-2.5 py-1 text-sm font-semibold tracking-wide text-white">
          {label}
        </div>
        {errored ? (
          <div className="text-center p-6 space-y-3">
            <p className="text-sm text-zinc-400">
              Browser can't display this file inline.
            </p>
            <a
              href={downloadUrl}
              className="inline-block text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Download to view locally
            </a>
          </div>
        ) : kind === "image" ? (
          <img
            src={streamUrl}
            alt={side.path}
            className={`max-w-full ${maxHeight} object-contain`}
            onError={() => setErrored(true)}
          />
        ) : kind === "video" ? (
          <video
            key={side.path}
            src={streamUrl}
            controls
            preload="metadata"
            className={`max-w-full ${maxHeight}`}
            onError={() => setErrored(true)}
          />
        ) : kind === "audio" ? (
          <audio
            key={side.path}
            src={streamUrl}
            controls
            preload="metadata"
            className="w-full"
            onError={() => setErrored(true)}
          />
        ) : (
          <div className="text-center p-6 space-y-3">
            <p className="text-sm text-zinc-400">Not a previewable media type.</p>
            <a
              href={downloadUrl}
              className="inline-block text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Download
            </a>
          </div>
        )}
      </div>

      <div className="text-xs space-y-1">
        <div className="font-mono text-zinc-300 break-all">{side.path}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-zinc-500">
          <span>{formatBytes(side.sizeBytes)}</span>
          {side.contentHash && (
            <span className="font-mono">hash: {side.contentHash.slice(0, 12)}…</span>
          )}
          <a href={downloadUrl} className="text-blue-400 hover:text-blue-300 underline">
            download
          </a>
        </div>
      </div>
    </div>
  );
}

function FramePanel({
  frame,
  label,
  immersive = false,
  onActivate,
}: {
  frame: EncodingComparisonFrame | null;
  label: string;
  immersive?: boolean;
  onActivate?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [frame?.path]);

  if (!frame) {
    return (
      <div className="relative aspect-video rounded border border-zinc-800 bg-zinc-950 flex items-center justify-center text-xs text-zinc-600">
        <div className="absolute left-3 top-3 rounded bg-black/80 px-2.5 py-1 text-sm font-semibold tracking-wide text-white">
          {label}
        </div>
        Missing frame
      </div>
    );
  }

  const maxHeight = immersive ? "max-h-[calc(100vh-18rem)]" : "max-h-[70vh]";

  return (
    <div className="space-y-2">
      <div
        role={onActivate ? "button" : undefined}
        tabIndex={onActivate ? 0 : undefined}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (!onActivate) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
        aria-label={onActivate ? `Show ${label === "A" ? "B" : "A"}` : undefined}
        className={`relative rounded border border-zinc-800 bg-black overflow-hidden flex items-center justify-center ${
          immersive ? "h-[calc(100vh-18rem)] min-h-[360px]" : "aspect-video"
        } ${onActivate ? "cursor-pointer select-none" : ""}`}
      >
        <div className="absolute left-3 top-3 z-10 rounded bg-black/80 px-2.5 py-1 text-sm font-semibold tracking-wide text-white">
          {label}
        </div>
        {errored ? (
          <a
            href={api.comparisons.mediaUrl(frame.path, { download: true })}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            Download frame
          </a>
        ) : (
          <img
            src={api.comparisons.mediaUrl(frame.path)}
            alt={`${label} frame ${frame.position}`}
            className={`max-w-full ${maxHeight} object-contain`}
            onError={() => setErrored(true)}
          />
        )}
      </div>
      <div className="text-[11px] text-zinc-600">
        {frame.atSeconds.toFixed(1)}s
      </div>
    </div>
  );
}

function EncodingFramesPanel({
  member,
  mode,
  activeSide,
  onActiveSideChange,
}: {
  member: ComparisonMember;
  mode: ViewMode;
  activeSide: ActiveSide;
  onActiveSideChange: (side: ActiveSide) => void;
}) {
  const [frameIndex, setFrameIndex] = useState(0);
  const frames = member.encodingFrames;
  const leftByPosition = new Map(frames?.leftFrames.map((f) => [f.position, f]) ?? []);
  const rightByPosition = new Map(frames?.rightFrames.map((f) => [f.position, f]) ?? []);
  const positions = Array.from(
    new Set([
      ...(frames?.leftFrames.map((f) => f.position) ?? []),
      ...(frames?.rightFrames.map((f) => f.position) ?? []),
    ])
  ).sort((a, b) => a - b);

  useEffect(() => {
    if (frameIndex >= positions.length) setFrameIndex(0);
  }, [frameIndex, positions.length]);

  if (!frames) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
        No extracted frames are attached to this comparison member.
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
        No completed A/B frames are attached to this comparison member.
      </div>
    );
  }

  const currentPosition = positions[frameIndex] ?? positions[0];
  const leftFrame = leftByPosition.get(currentPosition) ?? null;
  const rightFrame = rightByPosition.get(currentPosition) ?? null;
  const activeFrame = activeSide === "left" ? leftFrame : rightFrame;
  const goPrevFrame = () => setFrameIndex((i) => (i <= 0 ? positions.length - 1 : i - 1));
  const goNextFrame = () => setFrameIndex((i) => (i >= positions.length - 1 ? 0 : i + 1));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={goPrevFrame}
          className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
        >
          ← Frame
        </button>
        <span className="text-zinc-400">
          Frame {frameIndex + 1} / {positions.length}
        </span>
        <button
          type="button"
          onClick={goNextFrame}
          className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
        >
          Frame →
        </button>
      </div>

      {mode === "side-by-side" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FramePanel frame={leftFrame} label="A" />
          <FramePanel frame={rightFrame} label="B" />
        </div>
      ) : (
        <FramePanel
          frame={activeFrame}
          label={sideLabel(activeSide)}
          immersive
          onActivate={() => onActiveSideChange(swapSide(activeSide))}
        />
      )}
    </div>
  );
}

function VerdictBar({
  kind,
  member,
  onVerdict,
  pending,
}: {
  kind: ComparisonKind;
  member: ComparisonMember;
  onVerdict: (v: ComparisonVerdict | null, note: string) => void;
  pending: boolean;
}) {
  const [note, setNote] = useState(member.verdictNote);
  useEffect(() => { setNote(member.verdictNote); }, [member.id, member.verdictNote]);

  const btn = (v: ComparisonVerdict, label: string, active: string) => {
    const isActive = member.verdict === v;
    return (
      <button
        onClick={() => onVerdict(v, note)}
        disabled={pending}
        className={`px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
          isActive ? active : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {kind === "encoding_frames" ? (
          <>
            {btn("prefer_left", "A better (A)", "bg-blue-700 text-white")}
            {btn("prefer_right", "B better (B)", "bg-violet-700 text-white")}
            {btn("tie", "Tie (T)", "bg-sky-700 text-white")}
            {btn("unsure", "Unsure (U)", "bg-amber-700 text-white")}
          </>
        ) : (
          <>
            {btn("same", "Same (S)", "bg-emerald-700 text-white")}
            {btn("different", "Different (D)", "bg-rose-700 text-white")}
            {btn("unsure", "Unsure (U)", "bg-amber-700 text-white")}
          </>
        )}
        {member.verdict !== null && (
          <button
            onClick={() => onVerdict(null, "")}
            disabled={pending}
            className="px-3 py-2 rounded text-xs text-zinc-400 hover:text-white"
          >
            Reset
          </button>
        )}
        {member.verdictedAt && (
          <span className="ml-auto text-xs text-zinc-500">
            Verdicted {formatDate(member.verdictedAt)}
          </span>
        )}
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== member.verdictNote && member.verdict !== null) {
            onVerdict(member.verdict, note);
          }
        }}
        placeholder="Optional note (saved on blur or next verdict)"
        className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

function Pair({
  batch,
  member,
  onPrev,
  onNext,
}: {
  batch: ComparisonBatchDetail;
  member: ComparisonMember;
  onPrev: () => void;
  onNext: () => void;
}) {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.matchMedia("(max-width: 767px)").matches ? "toggle" : "side-by-side"
  );
  const [activeSide, setActiveSide] = useState<ActiveSide>("left");
  const verdictMutation = useMutation({
    mutationFn: (body: { verdict: ComparisonVerdict | null; note: string }) =>
      api.comparisons.verdict(batch.id, member.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comparison", batch.id] });
      queryClient.invalidateQueries({ queryKey: ["comparisons"] });
    },
  });

  const onVerdict = useCallback(
    (verdict: ComparisonVerdict | null, note: string) => {
      verdictMutation.mutate({ verdict, note });
    },
    [verdictMutation]
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (batch.kind === "encoding_frames") {
        if (e.key === "a" || e.key === "A" || e.key === "l" || e.key === "L") {
          onVerdict("prefer_left", member.verdictNote);
        } else if (e.key === "b" || e.key === "B" || e.key === "r" || e.key === "R") onVerdict("prefer_right", member.verdictNote);
        else if (e.key === "t" || e.key === "T") onVerdict("tie", member.verdictNote);
        else if (e.key === "u" || e.key === "U") onVerdict("unsure", member.verdictNote);
        else if (e.key === " ") {
          e.preventDefault();
          setActiveSide((side) => swapSide(side));
        }
        else if (e.key === "ArrowRight" || e.key === "n") onNext();
        else if (e.key === "ArrowLeft" || e.key === "p") onPrev();
      } else if (e.key === "s" || e.key === "S") onVerdict("same", member.verdictNote);
      else if (e.key === "d" || e.key === "D") onVerdict("different", member.verdictNote);
      else if (e.key === "u" || e.key === "U") onVerdict("unsure", member.verdictNote);
      else if (e.key === " ") {
        e.preventDefault();
        setActiveSide((side) => swapSide(side));
      }
      else if (e.key === "ArrowRight" || e.key === "n") onNext();
      else if (e.key === "ArrowLeft" || e.key === "p") onPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [batch.kind, onVerdict, onNext, onPrev, member.verdictNote]);

  return (
    <div className="space-y-4">
      {member.note && (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400 whitespace-pre-wrap">
          {member.note}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewModeControl mode={viewMode} onModeChange={setViewMode} />
        {viewMode === "toggle" && (
          <div className="inline-flex overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
            {(["left", "right"] as const).map((side) => {
              const active = activeSide === side;
              return (
                <button
                  key={side}
                  type="button"
                  onClick={() => setActiveSide(side)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-zinc-200 text-zinc-950"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  }`}
                >
                  {sideLabel(side)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {batch.kind === "encoding_frames" ? (
        <EncodingFramesPanel
          member={member}
          mode={viewMode}
          activeSide={activeSide}
          onActiveSideChange={setActiveSide}
        />
      ) : viewMode === "side-by-side" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MediaPanel side={member.left} label="A" />
          <MediaPanel side={member.right} label="B" />
        </div>
      ) : (
        <MediaPanel
          side={activeSide === "left" ? member.left : member.right}
          label={sideLabel(activeSide)}
          immersive
          onActivate={() => setActiveSide((side) => swapSide(side))}
        />
      )}

      <VerdictBar
        kind={batch.kind}
        member={member}
        onVerdict={onVerdict}
        pending={verdictMutation.isPending}
      />
    </div>
  );
}

function verdictDot(v: ComparisonVerdict | null) {
  if (v === "same") return "bg-emerald-500";
  if (v === "different") return "bg-rose-500";
  if (v === "prefer_left") return "bg-blue-500";
  if (v === "prefer_right") return "bg-violet-500";
  if (v === "tie") return "bg-sky-500";
  if (v === "unsure") return "bg-amber-500";
  return "bg-zinc-600";
}

// Read the `?m=<id>` query param. We don't get reactivity from the Router for
// query strings, so the parent re-reads window.location.search on render and
// listens to popstate via a local state hook.
function useMemberIdFromUrl(): [number | null, (id: number | null) => void] {
  const [memberId, setMemberId] = useState<number | null>(() => {
    const v = new URLSearchParams(window.location.search).get("m");
    return v ? Number(v) : null;
  });

  useEffect(() => {
    const handler = () => {
      const v = new URLSearchParams(window.location.search).get("m");
      setMemberId(v ? Number(v) : null);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const update = (id: number | null) => {
    const params = new URLSearchParams(window.location.search);
    if (id === null) params.delete("m");
    else params.set("m", String(id));
    const next = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}`;
    history.replaceState(null, "", next);
    setMemberId(id);
  };

  return [memberId, update];
}

export function CompareBatchPage({ id }: { id: string }) {
  const batchId = Number(id);

  const { data: batch, isLoading, error } = useQuery({
    queryKey: ["comparison", batchId],
    queryFn: () => api.comparisons.get(batchId),
  });

  const members = useMemo(() => batch?.members ?? [], [batch]);
  const [memberId, setMemberId] = useMemberIdFromUrl();

  // Pick a default member: first pending, falling back to the first member.
  // Only runs when the data lands and no `?m=` is set (or the URL points at a
  // member that no longer exists, e.g. after a different batch).
  useEffect(() => {
    if (members.length === 0) return;
    const validId = memberId !== null && members.some((m) => m.id === memberId);
    if (validId) return;
    const firstPending = members.find((m) => m.verdict === null);
    setMemberId((firstPending ?? members[0]).id);
  }, [members, memberId, setMemberId]);

  const currentIndex = members.findIndex((m) => m.id === memberId);
  const current = currentIndex >= 0 ? members[currentIndex] : null;

  const goPrev = useCallback(() => {
    if (members.length === 0) return;
    const i = currentIndex <= 0 ? members.length - 1 : currentIndex - 1;
    setMemberId(members[i].id);
  }, [currentIndex, members, setMemberId]);

  const goNext = useCallback(() => {
    if (members.length === 0) return;
    const i = currentIndex < 0 || currentIndex >= members.length - 1 ? 0 : currentIndex + 1;
    setMemberId(members[i].id);
  }, [currentIndex, members, setMemberId]);

  if (isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (error || !batch) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href="/compare" className="text-sm text-blue-400 hover:underline">
          ← All batches
        </Link>
        <p className="text-sm text-rose-400">Failed to load batch.</p>
      </div>
    );
  }

  const { progress } = batch;
  const verdicted = progress.total - progress.pending;
  const shortcutText =
    batch.kind === "encoding_frames"
      ? "Shortcuts: A=A better · B=B better · T=tie · U=unsure · ←/→ navigate"
      : "Shortcuts: S=same · D=different · U=unsure · ←/→ navigate";

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/compare" className="text-sm text-blue-400 hover:underline">
          ← All batches
        </Link>
        <span className="text-zinc-700">/</span>
        <h1 className="text-base font-semibold text-white">{batch.name}</h1>
        <span className="ml-auto text-xs text-zinc-500">
          {verdicted}/{progress.total} reviewed
        </span>
      </div>

      {batch.rationale && (
        <p className="text-xs text-zinc-400 whitespace-pre-wrap">{batch.rationale}</p>
      )}

      {/* Dot index — click a dot to jump to that pair. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {members.map((m, i) => (
          <button
            key={m.id}
            onClick={() => setMemberId(m.id)}
            title={`#${i + 1} ${m.verdict ?? "pending"}`}
            className={`w-3 h-3 rounded-full ${verdictDot(m.verdict)} ${
              m.id === memberId ? "ring-2 ring-blue-400" : ""
            }`}
          />
        ))}
      </div>

      {current ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={goPrev}
              className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
            >
              ← Prev
            </button>
            <span className="text-zinc-400">
              Pair {currentIndex + 1} / {members.length}
            </span>
            <button
              onClick={goNext}
              className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
            >
              Next →
            </button>
            <span className="ml-auto text-xs text-zinc-500">
              {shortcutText}
            </span>
          </div>

          <Pair batch={batch} member={current} onPrev={goPrev} onNext={goNext} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">This batch has no members.</p>
      )}
    </div>
  );
}
