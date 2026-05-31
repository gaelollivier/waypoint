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

function mediaKind(path: string): MediaKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "other";
}

function MediaPanel({ side, label }: { side: ComparisonSide; label: string }) {
  const [errored, setErrored] = useState(false);
  const kind = mediaKind(side.path);
  const streamUrl = api.comparisons.mediaUrl(side.path);
  const downloadUrl = api.comparisons.mediaUrl(side.path, { download: true });

  // Reset error state when the source path changes (prev/next nav).
  useEffect(() => { setErrored(false); }, [side.path]);

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>

      <div className="flex-1 min-h-0 rounded-md border border-zinc-800 bg-black overflow-hidden flex items-center justify-center">
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
            className="max-w-full max-h-[70vh] object-contain"
            onError={() => setErrored(true)}
          />
        ) : kind === "video" ? (
          <video
            key={side.path}
            src={streamUrl}
            controls
            preload="metadata"
            className="max-w-full max-h-[70vh]"
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

function FrameImage({ frame, label }: { frame: EncodingComparisonFrame | null; label: string }) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [frame?.path]);

  if (!frame) {
    return (
      <div className="aspect-video rounded border border-zinc-800 bg-zinc-950 flex items-center justify-center text-xs text-zinc-600">
        Missing
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="aspect-video rounded border border-zinc-800 bg-black overflow-hidden flex items-center justify-center">
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
            className="w-full h-full object-contain"
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

function EncodingFramesPanel({ member }: { member: ComparisonMember }) {
  const frames = member.encodingFrames;
  if (!frames) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
        No extracted frames are attached to this comparison member.
      </div>
    );
  }

  const sourceByPosition = new Map(frames.sourceFrames.map((f) => [f.position, f]));
  const leftByPosition = new Map(frames.leftFrames.map((f) => [f.position, f]));
  const rightByPosition = new Map(frames.rightFrames.map((f) => [f.position, f]));
  const positions = Array.from(
    new Set([
      ...frames.sourceFrames.map((f) => f.position),
      ...frames.leftFrames.map((f) => f.position),
      ...frames.rightFrames.map((f) => f.position),
    ])
  ).sort((a, b) => a - b);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs uppercase tracking-wide text-zinc-500">
        <div />
        <div>Source</div>
        <div>Left</div>
        <div>Right</div>
      </div>

      <div className="space-y-3">
        {positions.map((position) => (
          <div
            key={position}
            className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 items-start"
          >
            <div className="text-xs text-zinc-500 pt-2">Frame {position + 1}</div>
            <FrameImage frame={sourceByPosition.get(position) ?? null} label="source" />
            <FrameImage frame={leftByPosition.get(position) ?? null} label="left" />
            <FrameImage frame={rightByPosition.get(position) ?? null} label="right" />
          </div>
        ))}
      </div>
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
            {btn("prefer_left", "Left (L)", "bg-blue-700 text-white")}
            {btn("prefer_right", "Right (R)", "bg-violet-700 text-white")}
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
        if (e.key === "l" || e.key === "L") onVerdict("prefer_left", member.verdictNote);
        else if (e.key === "r" || e.key === "R") onVerdict("prefer_right", member.verdictNote);
        else if (e.key === "t" || e.key === "T") onVerdict("tie", member.verdictNote);
        else if (e.key === "u" || e.key === "U") onVerdict("unsure", member.verdictNote);
        else if (e.key === "ArrowRight" || e.key === "n") onNext();
        else if (e.key === "ArrowLeft" || e.key === "p") onPrev();
      } else if (e.key === "s" || e.key === "S") onVerdict("same", member.verdictNote);
      else if (e.key === "d" || e.key === "D") onVerdict("different", member.verdictNote);
      else if (e.key === "u" || e.key === "U") onVerdict("unsure", member.verdictNote);
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

      {batch.kind === "encoding_frames" ? (
        <EncodingFramesPanel member={member} />
      ) : (
        <div className="flex flex-col lg:flex-row gap-4">
          <MediaPanel side={member.left} label="Left" />
          <MediaPanel side={member.right} label="Right" />
        </div>
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
      ? "Shortcuts: L=left · R=right · T=tie · U=unsure · ←/→ navigate"
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
