import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api/client";
import { navigate } from "./Router";
import type { CleanupHaltedBody, CleanupResponse, DirectoryGroupInventoryResponse, DuplicateDirectoriesResponse, DuplicateDirectoryGroup, DuplicateDirectoryGroupMember, DuplicateGroup, DuplicateGroupFile, DuplicatesResponse } from "../api/types";
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
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
          group.hashKind === "full"
            ? "bg-green-950/40 text-green-400"
            : "bg-amber-950/40 text-amber-400"
        }`}>
          {group.hashKind}
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
        <div className="pt-1 flex items-center gap-3">
          <button
            disabled={!group.canDelete}
            onClick={() => onCleanupRequest(group, selectedKeepFile)}
            className="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Delete {filesToDelete.length} duplicate{filesToDelete.length > 1 ? "s" : ""}
          </button>
          {!group.canDelete && (
            <span className="text-xs text-amber-400">Cleanup requires full-hash evidence.</span>
          )}
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
  haltedResult,
  onConfirm,
  onClose,
}: {
  group: DuplicateGroup;
  keepFile: DuplicateGroupFile;
  isPending: boolean;
  lastResult: CleanupResponse | null;
  haltedResult: CleanupHaltedBody | null;
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

        {haltedResult ? (
          // Cleanup halted mid-way: surface the failure and what got deleted before
          <div className="space-y-3">
            <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-red-400 font-medium">
                Cleanup halted
              </div>
              <div className="text-sm text-red-300 break-words">{haltedResult.error}</div>
              <div className="text-xs text-red-400/80">
                <span className="font-mono break-all">{haltedResult.failedAt.path}</span>
              </div>
            </div>

            <div className="text-sm text-zinc-300">
              {haltedResult.deletedCount} file{haltedResult.deletedCount !== 1 ? "s" : ""} deleted
              {" "}before the halt; remaining files were not attempted.
            </div>

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded bg-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        ) : lastResult ? (
          // Show results after a clean cleanup
          <div className="space-y-3">
            <div className="text-sm text-zinc-300">
              {lastResult.deletedCount} file{lastResult.deletedCount !== 1 ? "s" : ""} deleted
            </div>

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
              The server will require full-hash evidence from the selected scan
              and re-check fresh sampled hashes for the kept and deleted files
              before deleting.
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
  onCleanupRequest,
}: {
  group: DuplicateDirectoryGroup;
  diskId: number;
  onCleanupRequest: (group: DuplicateDirectoryGroup, keepDir: DuplicateDirectoryGroupMember) => void;
}) {
  const [keepId, setKeepId] = useState<number | null>(null);
  const keepDir = group.directories.find((d) => d.directoryId === keepId) ?? null;
  const deleteCount = keepDir ? group.directories.length - 1 : 0;

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
          <div key={d.directoryId} className="flex items-center gap-2 group">
            {group.canDelete ? (
              <button
                onClick={() => setKeepId(keepId === d.directoryId ? null : d.directoryId)}
                className={`shrink-0 w-5 h-5 rounded border text-xs flex items-center justify-center transition-colors ${
                  keepId === d.directoryId
                    ? "border-green-500 bg-green-500/20 text-green-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-600 hover:border-zinc-500"
                }`}
                title={keepId === d.directoryId ? "Deselect" : "Keep this copy"}
              >
                {keepId === d.directoryId ? "✓" : ""}
              </button>
            ) : (
              <span className="shrink-0 text-xs text-zinc-600">📁</span>
            )}
            <a
              href={`/disks/${diskId}?tab=tree&treePath=${encodeURIComponent(d.path)}`}
              className={`font-mono text-xs truncate hover:underline ${
                keepId !== null && keepId !== d.directoryId
                  ? "text-red-400/70 line-through"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              title={d.path}
            >
              {d.path}
            </a>
            {keepId === d.directoryId && (
              <span className="text-[10px] text-green-500 font-medium shrink-0">KEEP</span>
            )}
          </div>
        ))}
      </div>

      {keepDir && deleteCount > 0 && (
        <div className="pt-1 flex items-center gap-3">
          <button
            onClick={() => onCleanupRequest(group, keepDir)}
            className="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors"
          >
            Delete {deleteCount} duplicate director{deleteCount > 1 ? "ies" : "y"}
          </button>
        </div>
      )}
      {!group.canDelete && (
        <div className="text-xs text-amber-400/80">
          Cleanup requires full-hash evidence for every file. Run a fullHash scan first.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Directory cleanup confirmation dialog
// ---------------------------------------------------------------------------

function DirectoryCleanupConfirmDialog({
  group,
  keepDir,
  diskId,
  onClose,
}: {
  group: DuplicateDirectoryGroup;
  keepDir: DuplicateDirectoryGroupMember;
  diskId: number;
  onClose: () => void;
}) {
  // Live inventory: walks each delete folder on disk right now so the user
  // sees every file (including .DS_Store and other noise the scan ignored)
  // before confirming.
  const inventoryQuery = useQuery<DirectoryGroupInventoryResponse>({
    queryKey: ["directoryGroupInventory", diskId, group.id],
    queryFn: () => api.duplicates.directoryGroupInventory(diskId, group.id),
    retry: false,
  });

  const deleteDirectories =
    inventoryQuery.data?.members.filter((m) => m.directoryId !== keepDir.directoryId) ?? [];

  // A delete folder with any unknown file, missing file, or directoryExists=false
  // is unsafe to cleanup until the user re-scans — we don't want a one-click
  // path to deleting anything that wasn't reviewed.
  const blockers: string[] = [];
  for (const m of deleteDirectories) {
    if (!m.directoryExists) {
      blockers.push(`${m.path}: directory no longer exists on disk`);
      continue;
    }
    if (m.unknown.length > 0) {
      blockers.push(
        `${m.path}: ${m.unknown.length} unknown file${m.unknown.length === 1 ? "" : "s"} on disk that the scan never saw`
      );
    }
    if (m.missing.length > 0) {
      blockers.push(
        `${m.path}: ${m.missing.length} scanned file${m.missing.length === 1 ? "" : "s"} no longer on disk`
      );
    }
  }
  const blocked = blockers.length > 0;

  const totalBytesFreed = group.totalSizeBytes * deleteDirectories.length;
  const totalScanned = deleteDirectories.reduce((acc, m) => acc + m.scanned.length, 0);
  const totalExcluded = deleteDirectories.reduce((acc, m) => acc + m.excluded.length, 0);

  const cleanup = useMutation({
    mutationFn: () =>
      api.duplicates.directoryCleanup(diskId, {
        duplicateDirectoryGroupId: group.id,
        keepDirectory: { directoryId: keepDir.directoryId, path: keepDir.path },
        deleteDirectories: deleteDirectories.map((m) => ({
          directoryId: m.directoryId,
          path: m.path,
          files: m.scanned.map((f) => ({ fileId: f.fileId, relativePath: f.relativePath })),
          excludedFiles: m.excluded.map((f) => ({ relativePath: f.relativePath })),
        })),
      }),
    onSuccess: ({ jobId }) => {
      navigate(`/jobs/${jobId}`);
    },
  });

  const errorMessage = cleanup.error instanceof Error ? cleanup.error.message : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5 max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white shrink-0">Confirm Directory Deletion</h2>

        {inventoryQuery.isLoading && (
          <div className="text-sm text-zinc-500">Reading folder contents from disk…</div>
        )}
        {inventoryQuery.error && (
          <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 text-xs text-red-400">
            {inventoryQuery.error instanceof Error ? inventoryQuery.error.message : String(inventoryQuery.error)}
          </div>
        )}

        {inventoryQuery.data && (
          <div className="space-y-4 overflow-y-auto pr-1 flex-1">
            <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-green-500 font-medium mb-1">Keeping</div>
              <div className="font-mono text-xs text-green-400 break-all">{keepDir.path}</div>
            </div>

            {deleteDirectories.map((m) => {
              const memberBlocked =
                !m.directoryExists || m.unknown.length > 0 || m.missing.length > 0;
              return (
                <details
                  key={m.directoryId}
                  className={
                    memberBlocked
                      ? "rounded-lg border border-amber-700/50 bg-amber-950/20"
                      : "rounded-lg border border-red-800/50 bg-red-950/20"
                  }
                >
                  <summary className="px-4 py-3 cursor-pointer text-xs flex items-center justify-between">
                    <div>
                      <div
                        className={
                          memberBlocked
                            ? "text-[10px] uppercase tracking-wider text-amber-400 font-medium mb-1"
                            : "text-[10px] uppercase tracking-wider text-red-400 font-medium mb-1"
                        }
                      >
                        {memberBlocked ? "Cannot delete — needs re-scan" : "Deleting directory"}
                      </div>
                      <div
                        className={memberBlocked ? "font-mono text-amber-300 break-all" : "font-mono text-red-300 break-all"}
                      >
                        {m.path}
                      </div>
                    </div>
                    <span
                      className={memberBlocked ? "text-amber-400/80 ml-3 shrink-0" : "text-red-400/80 ml-3 shrink-0"}
                    >
                      {m.scanned.length + m.excluded.length} file
                      {m.scanned.length + m.excluded.length === 1 ? "" : "s"}
                    </span>
                  </summary>
                  <div className="px-4 pb-3 space-y-2 border-t border-red-800/30 pt-2 max-h-72 overflow-y-auto">
                    {!m.directoryExists && (
                      <div className="text-[11px] text-amber-300/90 italic">
                        This folder is no longer on disk. Re-run duplicate detection to refresh the result.
                      </div>
                    )}

                    {m.scanned.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                          Scan-recorded files ({m.scanned.length})
                        </div>
                        {m.scanned.map((f) => (
                          <div
                            key={`s-${f.fileId}`}
                            className="flex items-center justify-between gap-2 font-mono text-[11px] text-red-300/80"
                          >
                            <span className="break-all">{f.relativePath}</span>
                            <span className="text-red-400/60 shrink-0">{formatBytes(f.sizeBytes)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {m.excluded.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                          OS noise ({m.excluded.length})
                        </div>
                        {m.excluded.map((f) => (
                          <div
                            key={`e-${f.relativePath}`}
                            className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-400"
                          >
                            <span className="break-all">{f.relativePath}</span>
                            <span className="text-zinc-500 shrink-0">{formatBytes(f.sizeBytes)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {m.unknown.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">
                          Unknown files — block deletion ({m.unknown.length})
                        </div>
                        {m.unknown.map((f) => (
                          <div
                            key={`u-${f.relativePath}`}
                            className="flex items-center justify-between gap-2 font-mono text-[11px] text-amber-300"
                          >
                            <span className="break-all">{f.relativePath}</span>
                            <span className="text-amber-400/60 shrink-0">{formatBytes(f.sizeBytes)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {m.missing.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">
                          Missing on disk — block deletion ({m.missing.length})
                        </div>
                        {m.missing.map((f) => (
                          <div
                            key={`m-${f.fileId}`}
                            className="font-mono text-[11px] text-amber-300 break-all"
                          >
                            {f.relativePath}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}

            <div className="text-xs text-zinc-500">
              {totalScanned} scanned file{totalScanned === 1 ? "" : "s"}
              {totalExcluded > 0 && ` + ${totalExcluded} OS noise file${totalExcluded === 1 ? "" : "s"}`}
              {" "}across {deleteDirectories.length}{" "}
              director{deleteDirectories.length === 1 ? "y" : "ies"}.
              Space freed: <span className="text-zinc-300">{formatBytes(totalBytesFreed)}</span>
            </div>

            {blocked && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-400 space-y-1">
                <div className="font-medium">Cannot proceed — re-scan and retry:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {blockers.map((b, i) => (
                    <li key={i} className="break-words">{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {!blocked && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-400">
                This action is permanent. The cleanup runs as a background job and
                fails fast on any drift — if anything changes between this dialog
                and the job, nothing in that folder is deleted.
              </div>
            )}

            {errorMessage && (
              <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 text-xs text-red-400 break-words">
                {errorMessage}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 shrink-0">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!inventoryQuery.data || cleanup.isPending || blocked}
            onClick={() => cleanup.mutate()}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cleanup.isPending ? "Starting…" : `Delete ${deleteDirectories.length} director${deleteDirectories.length === 1 ? "y" : "ies"}`}
          </button>
        </div>
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
  const [cleanupTarget, setCleanupTarget] = useState<{
    group: DuplicateDirectoryGroup;
    keepDir: DuplicateDirectoryGroupMember;
  } | null>(null);

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
                onCleanupRequest={(g, keepDir) => setCleanupTarget({ group: g, keepDir })}
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

      {cleanupTarget && (
        <DirectoryCleanupConfirmDialog
          group={cleanupTarget.group}
          keepDir={cleanupTarget.keepDir}
          diskId={diskId}
          onClose={() => setCleanupTarget(null)}
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
          haltedResult={
            cleanup.error instanceof ApiError && cleanup.error.status === 500
              ? (cleanup.error.body as CleanupHaltedBody)
              : null
          }
          onConfirm={handleConfirm}
          onClose={handleCloseDialog}
        />
      )}
    </div>
  );
}
