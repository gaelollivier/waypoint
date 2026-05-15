import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CleanupResponse, DuplicateDirectoriesResponse, DuplicateGroup, DuplicateGroupFile, DuplicatesResponse } from "../api/types";
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
// Group card — with "keep" selection and cleanup button
// ---------------------------------------------------------------------------

function DuplicateGroupCard({
  group,
  diskId,
  onCleanupRequest,
}: {
  group: DuplicateGroup;
  diskId: number;
  onCleanupRequest: (group: DuplicateGroup, keepFile: DuplicateGroupFile) => void;
}) {
  const [keepFileId, setKeepFileId] = useState<number | null>(null);

  const liveFiles = group.files.filter((f) => f.deletedAt === null);
  const selectedKeepFile = liveFiles.find((f) => f.fileId === keepFileId);
  const filesToDelete = keepFileId
    ? liveFiles.filter((f) => f.fileId !== keepFileId)
    : [];

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

      <div className="space-y-1">
        {group.files.map((f) => {
          const alreadyDeleted = f.deletedAt !== null;
          return (
            <div
              key={f.fileId}
              className={`flex items-center gap-2 group ${alreadyDeleted ? "opacity-50" : ""}`}
            >
              {alreadyDeleted ? (
                <span
                  className="shrink-0 w-5 h-5 rounded border border-zinc-700 bg-zinc-800 text-xs flex items-center justify-center text-zinc-600"
                  title="Already deleted"
                >
                  ×
                </span>
              ) : (
                <button
                  onClick={() => setKeepFileId(keepFileId === f.fileId ? null : f.fileId)}
                  className={`shrink-0 w-5 h-5 rounded border text-xs flex items-center justify-center transition-colors ${
                    keepFileId === f.fileId
                      ? "border-green-500 bg-green-500/20 text-green-400"
                      : "border-zinc-700 bg-zinc-800 text-zinc-600 hover:border-zinc-500"
                  }`}
                  title={keepFileId === f.fileId ? "Deselect" : "Keep this copy"}
                >
                  {keepFileId === f.fileId ? "✓" : ""}
                </button>
              )}
              <a
                href={`/disks/${diskId}?tab=tree&treePath=${encodeURIComponent(f.path.substring(0, f.path.lastIndexOf("/")))}`}
                className={`font-mono text-xs truncate hover:underline ${
                  alreadyDeleted
                    ? "text-zinc-600 line-through"
                    : keepFileId !== null && keepFileId !== f.fileId
                      ? "text-red-400/70 line-through"
                      : "text-zinc-500 hover:text-zinc-300"
                }`}
                title={f.path}
              >
                {f.path}
              </a>
              {alreadyDeleted && (
                <span className="text-[10px] text-zinc-600 font-medium shrink-0">DELETED</span>
              )}
              {!alreadyDeleted && keepFileId === f.fileId && (
                <span className="text-[10px] text-green-500 font-medium shrink-0">KEEP</span>
              )}
            </div>
          );
        })}
      </div>

      {selectedKeepFile && filesToDelete.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => onCleanupRequest(group, selectedKeepFile)}
            className="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors"
          >
            Delete {filesToDelete.length} duplicate{filesToDelete.length > 1 ? "s" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cleanup confirmation dialog
// ---------------------------------------------------------------------------

function CleanupConfirmDialog({
  group,
  keepFile,
  isPending,
  lastResult,
  onConfirm,
  onClose,
}: {
  group: DuplicateGroup;
  keepFile: DuplicateGroupFile;
  isPending: boolean;
  lastResult: CleanupResponse | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const filesToDelete = group.files.filter((f) => f.fileId !== keepFile.fileId);
  const totalBytesFreed = group.sizeBytes * filesToDelete.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white">Confirm Deletion</h2>

        {lastResult ? (
          // Show results after cleanup
          <div className="space-y-3">
            <div className="text-sm text-zinc-300">
              {lastResult.deletedCount} file{lastResult.deletedCount !== 1 ? "s" : ""} deleted
              {lastResult.errorCount > 0 && (
                <span className="text-red-400">
                  , {lastResult.errorCount} error{lastResult.errorCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {lastResult.errorCount > 0 && (
              <div className="space-y-1">
                {lastResult.results
                  .filter((r) => r.status === "error")
                  .map((r) => (
                    <div key={r.fileId} className="rounded border border-red-800/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                      <span className="font-mono">{r.path}</span>: {r.error}
                    </div>
                  ))}
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded bg-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          // Show confirmation before cleanup
          <>
            <div className="space-y-3">
              <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-green-500 font-medium mb-1">Keeping</div>
                <div className="font-mono text-xs text-green-400 break-all">{keepFile.path}</div>
              </div>

              <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-red-400 font-medium mb-1">
                  Deleting ({filesToDelete.length} file{filesToDelete.length !== 1 ? "s" : ""})
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {filesToDelete.map((f) => (
                    <div key={f.fileId} className="font-mono text-xs text-red-300/80 break-all">
                      {f.path}
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-xs text-zinc-500">
                Space freed: <span className="text-zinc-300">{formatBytes(totalBytesFreed)}</span>
              </div>
            </div>

            <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-400">
              This action is permanent. The deleted files cannot be recovered.
              The server will verify that each file is an exact byte-for-byte
              copy of the kept file before deleting.
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={isPending}
                onClick={onConfirm}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isPending ? "Deleting…" : "Delete Files"}
              </button>
            </div>
          </>
        )}
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
// Directory duplicate group card
// ---------------------------------------------------------------------------

function DirectoryGroupCard({
  group,
  diskId,
}: {
  group: DuplicateDirectoriesResponse["groups"][number];
  diskId: number;
}) {
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-zinc-300 font-medium">
          {group.directoryCount} copies
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">
          {group.fileCount} file{group.fileCount === 1 ? "" : "s"} each
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{formatBytes(group.totalSizeBytes)} each</span>
        <span className="text-zinc-600">·</span>
        <span className="text-amber-400 font-medium">
          {formatBytes(group.wastedBytes)} wasted
        </span>
      </div>

      <div className="space-y-1">
        {group.directories.map((d) => (
          <div key={d.directoryId} className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-zinc-600">📁</span>
            <a
              href={`/disks/${diskId}?tab=tree&treePath=${encodeURIComponent(d.path)}`}
              className="font-mono text-xs text-zinc-500 truncate hover:text-zinc-300 hover:underline"
              title={d.path}
            >
              {d.path}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Directory duplicates view
// ---------------------------------------------------------------------------

type DirSortOption = "wasted" | "total_size" | "directory_count" | "file_count";

const DIR_SORT_LABELS: Record<DirSortOption, string> = {
  wasted:          "Wasted space",
  total_size:      "Total size",
  directory_count: "Copy count",
  file_count:      "File count",
};

function DirectoryDuplicatesView({
  diskId,
  duplicateJobId,
}: {
  diskId: number;
  duplicateJobId?: number;
}) {
  const [sort, setSort] = useState<DirSortOption>("wasted");
  const [minSize, setMinSize] = useState(0);
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = useQuery<DuplicateDirectoriesResponse>({
    queryKey: ["duplicateDirectories", diskId, duplicateJobId, sort, minSize, offset],
    queryFn: () =>
      api.duplicates.directories(diskId, {
        duplicateJobId,
        sort,
        minSize,
        limit: PAGE_SIZE,
        offset,
      }),
    retry: false,
  });

  const selectClass =
    "rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500";

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
        Loading directory duplicates…
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
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-zinc-500">Sort by</label>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as DirSortOption); setOffset(0); }}
          className={selectClass}
        >
          {(Object.keys(DIR_SORT_LABELS) as DirSortOption[]).map((k) => (
            <option key={k} value={k}>{DIR_SORT_LABELS[k]}</option>
          ))}
        </select>

        <select
          value={minSize}
          onChange={(e) => { setMinSize(Number(e.target.value)); setOffset(0); }}
          className={selectClass}
        >
          {MIN_SIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span className="text-zinc-400">
          {data.totalGroups.toLocaleString()} directory group{data.totalGroups === 1 ? "" : "s"}
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">
          {data.totalFileCount.toLocaleString()} file{data.totalFileCount === 1 ? "" : "s"}
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-amber-400">{formatBytes(data.totalWastedBytes)} wasted</span>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
        {data.groups.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            No duplicate directories found on this disk.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {data.groups.map((group) => (
              <DirectoryGroupCard
                key={group.id}
                group={group}
                diskId={diskId}
              />
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

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

type ViewMode = "files" | "directories";

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const btnClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? "bg-zinc-700 text-white"
        : "text-zinc-500 hover:text-zinc-300"
    }`;

  return (
    <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
      <button className={btnClass(mode === "files")} onClick={() => onChange("files")}>
        Files
      </button>
      <button className={btnClass(mode === "directories")} onClick={() => onChange("directories")}>
        Directories
      </button>
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
  const [viewMode, setViewMode] = useState<ViewMode>("files");
  const [sort, setSort] = useState<SortOption>("wasted");
  const [minSize, setMinSize] = useState(0);
  const [minCopies, setMinCopies] = useState(2);
  const [offset, setOffset] = useState(0);

  const [cleanupTarget, setCleanupTarget] = useState<{
    group: DuplicateGroup;
    keepFile: DuplicateGroupFile;
  } | null>(null);

  const queryClient = useQueryClient();

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
    enabled: viewMode === "files",
  });

  const cleanup = useMutation({
    mutationFn: (target: { group: DuplicateGroup; keepFile: DuplicateGroupFile }) =>
      api.duplicates.cleanup(diskId, {
        duplicateGroupId: target.group.id,
        keepFile: { fileId: target.keepFile.fileId, path: target.keepFile.path },
        deleteFiles: target.group.files
          .filter((f) => f.fileId !== target.keepFile.fileId)
          .map((f) => ({ fileId: f.fileId, path: f.path })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["duplicates", diskId] });
    },
  });

  const handleCleanupRequest = (group: DuplicateGroup, keepFile: DuplicateGroupFile) => {
    cleanup.reset();
    setCleanupTarget({ group, keepFile });
  };

  const handleConfirm = () => {
    if (!cleanupTarget) return;
    cleanup.mutate(cleanupTarget);
  };

  const handleCloseDialog = () => {
    setCleanupTarget(null);
    cleanup.reset();
  };

  return (
    <div className="space-y-4">
      <ViewModeToggle mode={viewMode} onChange={setViewMode} />

      {viewMode === "directories" ? (
        <DirectoryDuplicatesView diskId={diskId} duplicateJobId={duplicateJobId} />
      ) : (
        <>
          <ControlsBar
            sort={sort}
            onSort={(s) => { setSort(s); resetOffset(); }}
            minSize={minSize}
            onMinSize={(n) => { setMinSize(n); resetOffset(); }}
            minCopies={minCopies}
            onMinCopies={(n) => { setMinCopies(n); resetOffset(); }}
          />

          {isLoading && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
              Loading duplicates…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-red-400">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          {data && (
            <>
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
                      <DuplicateGroupCard
                        key={group.id}
                        group={group}
                        diskId={diskId}
                        onCleanupRequest={handleCleanupRequest}
                      />
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
            </>
          )}
        </>
      )}

      {/* Cleanup confirmation dialog */}
      {cleanupTarget && (
        <CleanupConfirmDialog
          group={cleanupTarget.group}
          keepFile={cleanupTarget.keepFile}
          isPending={cleanup.isPending}
          lastResult={cleanup.data ?? null}
          onConfirm={handleConfirm}
          onClose={handleCloseDialog}
        />
      )}
    </div>
  );
}
