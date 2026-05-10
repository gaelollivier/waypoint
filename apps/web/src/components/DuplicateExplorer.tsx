import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { DuplicateGroup, DuplicatesResponse } from "../api/types";
import { formatBytes } from "../lib/format";

const PAGE_SIZE = 50;

type SortOption = "wasted" | "total_size" | "file_count" | "size";

const SORT_LABELS: Record<SortOption, string> = {
  wasted:     "Wasted space",
  total_size: "Total size",
  file_count: "File count",
  size:       "File size each",
};

const MIN_SIZE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "Any size",  value: 0 },
  { label: "≥ 1 MB",   value: 1_000_000 },
  { label: "≥ 10 MB",  value: 10_000_000 },
  { label: "≥ 100 MB", value: 100_000_000 },
  { label: "≥ 1 GB",   value: 1_000_000_000 },
];

const MIN_COPIES_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "2+ copies",  value: 2 },
  { label: "3+ copies",  value: 3 },
  { label: "5+ copies",  value: 5 },
  { label: "10+ copies", value: 10 },
];

// ---------------------------------------------------------------------------
// Controls bar
// ---------------------------------------------------------------------------

function ControlsBar({
  sort, onSort,
  minSize, onMinSize,
  minCopies, onMinCopies,
}: {
  sort: SortOption; onSort: (s: SortOption) => void;
  minSize: number; onMinSize: (n: number) => void;
  minCopies: number; onMinCopies: (n: number) => void;
}) {
  const selectClass =
    "rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500";

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="text-xs text-zinc-500">Sort by</label>
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as SortOption)}
        className={selectClass}
      >
        {(Object.keys(SORT_LABELS) as SortOption[]).map((k) => (
          <option key={k} value={k}>{SORT_LABELS[k]}</option>
        ))}
      </select>

      <select
        value={minSize}
        onChange={(e) => onMinSize(Number(e.target.value))}
        className={selectClass}
      >
        {MIN_SIZE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <select
        value={minCopies}
        onChange={(e) => onMinCopies(Number(e.target.value))}
        className={selectClass}
      >
        {MIN_COPIES_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group card
// ---------------------------------------------------------------------------

function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-zinc-300 font-medium">
          {group.fileCount} copies
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{formatBytes(group.sizeBytes)} each</span>
        <span className="text-zinc-600">·</span>
        <span className="text-amber-400 font-medium">
          {formatBytes(group.wastedBytes)} wasted
        </span>
      </div>

      <div className="space-y-0.5">
        {group.files.map((f) => (
          <div
            key={f.fileId}
            className="font-mono text-xs text-zinc-500 truncate"
            title={f.path}
          >
            {f.path}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({
  offset,
  total,
  onPrev,
  onNext,
}: {
  offset: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const btnClass =
    "px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center justify-between text-xs text-zinc-500">
      <span>{total === 0 ? "0" : `${start}–${end} of ${total.toLocaleString()}`}</span>
      <div className="flex gap-2">
        <button onClick={onPrev} disabled={offset === 0} className={btnClass}>
          ← Prev
        </button>
        <button onClick={onNext} disabled={end >= total} className={btnClass}>
          Next →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DuplicateExplorer
// ---------------------------------------------------------------------------

export function DuplicateExplorer({
  diskId,
  duplicateJobId,
}: {
  diskId: number;
  duplicateJobId?: number;
}) {
  const [sort, setSort] = useState<SortOption>("wasted");
  const [minSize, setMinSize] = useState(0);
  const [minCopies, setMinCopies] = useState(2);
  const [offset, setOffset] = useState(0);

  const resetOffset = () => setOffset(0);

  const { data, isLoading, error } = useQuery<DuplicatesResponse>({
    queryKey: ["duplicates", diskId, duplicateJobId, sort, minSize, minCopies, offset],
    queryFn: () =>
      api.duplicates.list(diskId, {
        duplicateJobId,
        sort,
        minSize,
        minCopies,
        limit: PAGE_SIZE,
        offset,
      }),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
        Loading duplicates…
      </div>
    );
  }

  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-red-400">
        {msg}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <ControlsBar
        sort={sort}
        onSort={(s) => { setSort(s); resetOffset(); }}
        minSize={minSize}
        onMinSize={(n) => { setMinSize(n); resetOffset(); }}
        minCopies={minCopies}
        onMinCopies={(n) => { setMinCopies(n); resetOffset(); }}
      />

      {/* Summary */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-zinc-400">
          {data.totalGroups.toLocaleString()} duplicate group{data.totalGroups === 1 ? "" : "s"}
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-amber-400">{formatBytes(data.totalWastedBytes)} wasted</span>
      </div>

      {/* Groups list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
        {data.groups.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            No duplicates found on this disk.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {data.groups.map((group) => (
              <DuplicateGroupCard key={group.id} group={group} />
            ))}
          </div>
        )}
      </div>

      {data.totalGroups > PAGE_SIZE && (
        <Pagination
          offset={offset}
          total={data.totalGroups}
          onPrev={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          onNext={() => setOffset((o) => o + PAGE_SIZE)}
        />
      )}
    </div>
  );
}
