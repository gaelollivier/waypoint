import { useEffect, useState, useMemo, useCallback, type ReactNode } from "react";
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
type InspectSource = {
  path: string;
  kind: MediaKind;
  alt: string;
  downloadUrl: string;
  detail?: string;
};

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

function CompactVerdictBar({
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
  const button = (v: ComparisonVerdict, label: string, active: string) => {
    const isActive = member.verdict === v;
    return (
      <button
        type="button"
        onClick={() => onVerdict(v, member.verdictNote)}
        disabled={pending}
        className={`rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
          isActive ? active : "bg-black/65 text-zinc-200 hover:bg-zinc-800"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {kind === "encoding_frames" ? (
        <>
          {button("prefer_left", "A better", "bg-blue-600 text-white")}
          {button("prefer_right", "B better", "bg-violet-600 text-white")}
          {button("tie", "Tie", "bg-sky-600 text-white")}
          {button("unsure", "Unsure", "bg-amber-600 text-white")}
        </>
      ) : (
        <>
          {button("same", "Same", "bg-emerald-600 text-white")}
          {button("different", "Different", "bg-rose-600 text-white")}
          {button("unsure", "Unsure", "bg-amber-600 text-white")}
        </>
      )}
    </div>
  );
}

function ToggleReviewSurface({
  kind,
  member,
  source,
  preloadSource,
  activeSide,
  pairLabel,
  fullSize,
  frameControls,
  pending,
  onActiveSideChange,
  onFullSizeChange,
  onModeChange,
  onNext,
  onPrev,
  onSwap,
  onVerdict,
}: {
  kind: ComparisonKind;
  member: ComparisonMember;
  source: InspectSource | null;
  preloadSource: InspectSource | null;
  activeSide: ActiveSide;
  pairLabel: string;
  fullSize: boolean;
  frameControls?: ReactNode;
  pending: boolean;
  onActiveSideChange: (side: ActiveSide) => void;
  onFullSizeChange: (fullSize: boolean) => void;
  onModeChange: (mode: ViewMode) => void;
  onNext: () => void;
  onPrev: () => void;
  onSwap: () => void;
  onVerdict: (v: ComparisonVerdict | null, note: string) => void;
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [source?.path]);

  const canFullSize = source?.kind === "image";

  return (
    <div className="fixed inset-0 z-50 h-[100dvh] w-screen overflow-hidden bg-black text-white">
      <div
        role="button"
        tabIndex={0}
        onClick={onSwap}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSwap();
          }
        }}
        className="absolute inset-0 flex h-full w-full touch-manipulation select-none items-center justify-center overflow-hidden bg-black"
        aria-label={`Show ${sideLabel(swapSide(activeSide))}`}
      >
        {source === null ? (
          <span className="text-sm text-zinc-500">Missing media</span>
        ) : errored ? (
          <a
            href={source.downloadUrl}
            onClick={(e) => e.stopPropagation()}
            className="rounded bg-black/80 px-4 py-3 text-sm text-blue-300 underline"
          >
            Download
          </a>
        ) : source.kind === "image" ? (
          <img
            src={source.path}
            alt={source.alt}
            draggable={false}
            onError={() => setErrored(true)}
            className={
              fullSize
                ? "max-h-none max-w-none object-none"
                : "max-h-full max-w-full object-contain"
            }
          />
        ) : source.kind === "video" ? (
          <video
            key={source.path}
            src={source.path}
            controls
            preload="metadata"
            onClick={(e) => e.stopPropagation()}
            onError={() => setErrored(true)}
            className="max-h-full max-w-full"
          />
        ) : source.kind === "audio" ? (
          <audio
            key={source.path}
            src={source.path}
            controls
            preload="metadata"
            onClick={(e) => e.stopPropagation()}
            onError={() => setErrored(true)}
            className="w-[min(32rem,80vw)]"
          />
        ) : (
          <a
            href={source.downloadUrl}
            onClick={(e) => e.stopPropagation()}
            className="rounded bg-black/80 px-4 py-3 text-sm text-blue-300 underline"
          >
            Download
          </a>
        )}
        {preloadSource?.kind === "image" && (
          <img src={preloadSource.path} alt="" aria-hidden="true" className="hidden" />
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/85 via-black/45 to-transparent p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <div className="rounded-md bg-white px-3 py-1 text-lg font-bold text-black">
            {sideLabel(activeSide)}
          </div>
          <div className="rounded-md bg-black/65 px-2.5 py-1.5 text-xs font-medium text-zinc-200">
            {pairLabel}
          </div>
          {source?.detail && (
            <div className="rounded-md bg-black/65 px-2.5 py-1.5 text-xs text-zinc-300">
              {source.detail}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onPrev()}
              className="rounded-md bg-black/65 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => onNext()}
              className="rounded-md bg-black/65 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            >
              Next
            </button>
            <div className="inline-flex overflow-hidden rounded-md border border-white/15 bg-black/65">
              {(["left", "right"] as const).map((side) => {
                const active = activeSide === side;
                return (
                  <button
                    key={side}
                    type="button"
                    onClick={() => onActiveSideChange(side)}
                    className={`px-3 py-2 text-sm font-semibold transition-colors ${
                      active ? "bg-white text-black" : "text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    {sideLabel(side)}
                  </button>
                );
              })}
            </div>
            {canFullSize && (
              <button
                type="button"
                onClick={() => onFullSizeChange(!fullSize)}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  fullSize
                    ? "bg-white text-black"
                    : "bg-black/65 text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                Full size
              </button>
            )}
            <button
              type="button"
              onClick={() => onModeChange("side-by-side")}
              className="rounded-md bg-black/65 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            >
              Side by side
            </button>
          </div>
        </div>
        {frameControls && (
          <div className="pointer-events-auto mt-2 flex flex-wrap items-center gap-2">
            {frameControls}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pb-4">
        <div className="pointer-events-auto">
          <CompactVerdictBar
            kind={kind}
            member={member}
            onVerdict={onVerdict}
            pending={pending}
          />
        </div>
      </div>
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

function EncodingFramesPanel({ member }: { member: ComparisonMember }) {
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FramePanel frame={leftFrame} label="A" />
        <FramePanel frame={rightFrame} label="B" />
      </div>
    </div>
  );
}

function mediaInspectSource(side: ComparisonSide): InspectSource {
  const streamUrl = api.comparisons.mediaUrl(side.path);
  return {
    path: streamUrl,
    kind: mediaKind(side.path),
    alt: side.path,
    downloadUrl: api.comparisons.mediaUrl(side.path, { download: true }),
  };
}

function MediaToggleSurface({
  batch,
  member,
  activeSide,
  fullSize,
  pairLabel,
  pending,
  onActiveSideChange,
  onFullSizeChange,
  onModeChange,
  onNext,
  onPrev,
  onVerdict,
}: {
  batch: ComparisonBatchDetail;
  member: ComparisonMember;
  activeSide: ActiveSide;
  fullSize: boolean;
  pairLabel: string;
  pending: boolean;
  onActiveSideChange: (side: ActiveSide) => void;
  onFullSizeChange: (fullSize: boolean) => void;
  onModeChange: (mode: ViewMode) => void;
  onNext: () => void;
  onPrev: () => void;
  onVerdict: (v: ComparisonVerdict | null, note: string) => void;
}) {
  const leftSource = mediaInspectSource(member.left);
  const rightSource = mediaInspectSource(member.right);
  const source = activeSide === "left" ? leftSource : rightSource;
  const preloadSource = activeSide === "left" ? rightSource : leftSource;

  return (
    <ToggleReviewSurface
      kind={batch.kind}
      member={member}
      source={source}
      preloadSource={preloadSource}
      activeSide={activeSide}
      pairLabel={pairLabel}
      fullSize={fullSize}
      pending={pending}
      onActiveSideChange={onActiveSideChange}
      onFullSizeChange={onFullSizeChange}
      onModeChange={onModeChange}
      onNext={onNext}
      onPrev={onPrev}
      onSwap={() => onActiveSideChange(swapSide(activeSide))}
      onVerdict={onVerdict}
    />
  );
}

function EncodingFrameToggleSurface({
  member,
  activeSide,
  fullSize,
  pairLabel,
  pending,
  onActiveSideChange,
  onFullSizeChange,
  onModeChange,
  onNext,
  onPrev,
  onVerdict,
}: {
  member: ComparisonMember;
  activeSide: ActiveSide;
  fullSize: boolean;
  pairLabel: string;
  pending: boolean;
  onActiveSideChange: (side: ActiveSide) => void;
  onFullSizeChange: (fullSize: boolean) => void;
  onModeChange: (mode: ViewMode) => void;
  onNext: () => void;
  onPrev: () => void;
  onVerdict: (v: ComparisonVerdict | null, note: string) => void;
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

  if (!frames || positions.length === 0) {
    return (
      <ToggleReviewSurface
        kind="encoding_frames"
        member={member}
        source={null}
        preloadSource={null}
        activeSide={activeSide}
        pairLabel={pairLabel}
        fullSize={fullSize}
        pending={pending}
        onActiveSideChange={onActiveSideChange}
        onFullSizeChange={onFullSizeChange}
        onModeChange={onModeChange}
        onNext={onNext}
        onPrev={onPrev}
        onSwap={() => onActiveSideChange(swapSide(activeSide))}
        onVerdict={onVerdict}
      />
    );
  }

  const currentPosition = positions[frameIndex] ?? positions[0];
  const leftFrame = leftByPosition.get(currentPosition) ?? null;
  const rightFrame = rightByPosition.get(currentPosition) ?? null;
  const frameToSource = (frame: EncodingComparisonFrame | null): InspectSource | null =>
    frame
      ? {
          path: api.comparisons.mediaUrl(frame.path),
          kind: "image",
          alt: `Frame ${frame.position + 1}`,
          downloadUrl: api.comparisons.mediaUrl(frame.path, { download: true }),
          detail: `${frame.atSeconds.toFixed(1)}s`,
        }
      : null;
  const source = frameToSource(activeSide === "left" ? leftFrame : rightFrame);
  const preloadSource = frameToSource(activeSide === "left" ? rightFrame : leftFrame);
  const goPrevFrame = () => setFrameIndex((i) => (i <= 0 ? positions.length - 1 : i - 1));
  const goNextFrame = () => setFrameIndex((i) => (i >= positions.length - 1 ? 0 : i + 1));

  const frameControls = (
    <>
      <button
        type="button"
        onClick={goPrevFrame}
        className="rounded-md bg-black/65 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
      >
        Prev frame
      </button>
      <div className="rounded-md bg-black/65 px-2.5 py-2 text-xs font-medium text-zinc-200">
        Frame {frameIndex + 1} / {positions.length}
      </div>
      <button
        type="button"
        onClick={goNextFrame}
        className="rounded-md bg-black/65 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
      >
        Next frame
      </button>
    </>
  );

  return (
    <ToggleReviewSurface
      kind="encoding_frames"
      member={member}
      source={source}
      preloadSource={preloadSource}
      activeSide={activeSide}
      pairLabel={pairLabel}
      fullSize={fullSize}
      frameControls={frameControls}
      pending={pending}
      onActiveSideChange={onActiveSideChange}
      onFullSizeChange={onFullSizeChange}
      onModeChange={onModeChange}
      onNext={onNext}
      onPrev={onPrev}
      onSwap={() => onActiveSideChange(swapSide(activeSide))}
      onVerdict={onVerdict}
    />
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
  pairLabel,
  onPrev,
  onNext,
}: {
  batch: ComparisonBatchDetail;
  member: ComparisonMember;
  pairLabel: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.matchMedia("(max-width: 767px)").matches ? "toggle" : "side-by-side"
  );
  const [activeSide, setActiveSide] = useState<ActiveSide>("left");
  const [fullSize, setFullSize] = useState(false);
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

  useEffect(() => { setActiveSide("left"); }, [member.id]);

  useEffect(() => {
    if (viewMode !== "toggle") return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [viewMode]);

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
        } else if (e.key === "f" || e.key === "F") {
          setFullSize((value) => !value);
        }
        else if (e.key === "ArrowRight" || e.key === "n") onNext();
        else if (e.key === "ArrowLeft" || e.key === "p") onPrev();
      } else if (e.key === "s" || e.key === "S") onVerdict("same", member.verdictNote);
      else if (e.key === "d" || e.key === "D") onVerdict("different", member.verdictNote);
      else if (e.key === "u" || e.key === "U") onVerdict("unsure", member.verdictNote);
      else if (e.key === " ") {
        e.preventDefault();
        setActiveSide((side) => swapSide(side));
      } else if (e.key === "f" || e.key === "F") {
        setFullSize((value) => !value);
      }
      else if (e.key === "ArrowRight" || e.key === "n") onNext();
      else if (e.key === "ArrowLeft" || e.key === "p") onPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [batch.kind, onVerdict, onNext, onPrev, member.verdictNote]);

  if (viewMode === "toggle") {
    return (
      <div className="space-y-4">
        {batch.kind === "encoding_frames" ? (
          <EncodingFrameToggleSurface
            member={member}
            activeSide={activeSide}
            fullSize={fullSize}
            pairLabel={pairLabel}
            pending={verdictMutation.isPending}
            onActiveSideChange={setActiveSide}
            onFullSizeChange={setFullSize}
            onModeChange={setViewMode}
            onNext={onNext}
            onPrev={onPrev}
            onVerdict={onVerdict}
          />
        ) : (
          <MediaToggleSurface
            batch={batch}
            member={member}
            activeSide={activeSide}
            fullSize={fullSize}
            pairLabel={pairLabel}
            pending={verdictMutation.isPending}
            onActiveSideChange={setActiveSide}
            onFullSizeChange={setFullSize}
            onModeChange={setViewMode}
            onNext={onNext}
            onPrev={onPrev}
            onVerdict={onVerdict}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {member.note && (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400 whitespace-pre-wrap">
          {member.note}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewModeControl mode={viewMode} onModeChange={setViewMode} />
      </div>

      {batch.kind === "encoding_frames" ? (
        <EncodingFramesPanel member={member} />
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

          <Pair
            batch={batch}
            member={current}
            pairLabel={`Pair ${currentIndex + 1} / ${members.length}`}
            onPrev={goPrev}
            onNext={goNext}
          />
        </>
      ) : (
        <p className="text-sm text-zinc-500">This batch has no members.</p>
      )}
    </div>
  );
}
