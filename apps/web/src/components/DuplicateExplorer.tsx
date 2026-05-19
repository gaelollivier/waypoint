import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api/client";
import type { CleanupHaltedBody, CleanupResponse, DirectoryGroupInventoryResponse, DuplicateDirectoriesResponse, DuplicateDirectoryGroup, DuplicateDirectoryGroupMember, DuplicateGroup, DuplicateGroupFile, DuplicatesResponse } from "../api/types";
import { formatBytes } from "../lib/format";
import { JobDetails } from "./JobDetails";
import { useLiveJob } from "../lib/useLiveJob";
import { useSearchParam, setSearchParams } from "../lib/urlState";

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

// Longest common path prefix across the group, trimmed back to the last "/" so
// every remainder starts at a directory boundary. Returns "" if there's nothing
// useful to factor out (single item, no shared prefix, or prefix is just "/").
export function pathCommonPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    let j = 0;
    while (j < prefix.length && j < paths[i].length && prefix[j] === paths[i][j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) return "";
  }
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return prefix.slice(0, lastSlash + 1);
}

export function stripPrefix(path: string, prefix: string): string {
  if (prefix && path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

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
  onExcludeRequest,
}: {
  group: DuplicateGroup;
  diskId: number;
  onCleanupRequest: (group: DuplicateGroup, keepFile: DuplicateGroupFile) => void;
  onExcludeRequest: (group: DuplicateGroup) => void;
}) {
  const [keepFileId, setKeepFileId] = useState<number | null>(null);

  const liveFiles = group.files.filter((f) => f.deletedAt === null);
  const selectedKeepFile = liveFiles.find((f) => f.fileId === keepFileId);
  const filesToDelete = keepFileId
    ? liveFiles.filter((f) => f.fileId !== keepFileId)
    : [];

  const commonPrefix = pathCommonPrefix(group.files.map((f) => f.path));

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

      {/* Single horizontal scroll container so prefix + all rows scroll as
          one block on narrow viewports, instead of each line scrolling alone. */}
      <div className="overflow-x-auto">
        {commonPrefix && (
          <div className="font-mono text-[11px] text-zinc-500 whitespace-nowrap pb-1">
            <span className="text-zinc-600">in </span>{commonPrefix}
          </div>
        )}
        <div className="space-y-1">
          {group.files.map((f) => {
            const alreadyDeleted = f.deletedAt !== null;
            const remainder = stripPrefix(f.path, commonPrefix);
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
                  className={`font-mono text-xs whitespace-nowrap hover:underline ${
                    alreadyDeleted
                      ? "text-zinc-600 line-through"
                      : keepFileId !== null && keepFileId !== f.fileId
                        ? "text-red-400/70 line-through"
                        : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  title={f.path}
                >
                  {remainder}
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
      </div>

      <div className="pt-1 flex items-center gap-3 flex-wrap">
        {selectedKeepFile && filesToDelete.length > 0 && (
          <>
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
          </>
        )}
        <button
          onClick={() => onExcludeRequest(group)}
          className="rounded px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors ml-auto"
          title="Exclude a folder from future duplicate detection"
        >
          Exclude folder…
        </button>
      </div>
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
  const commonPrefix = pathCommonPrefix([keepFile.path, ...filesToDelete.map((f) => f.path)]);

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
              <div className="text-xs text-red-400/80 font-mono break-all">
                {haltedResult.failedAt.path}
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
              {commonPrefix && (
                <div className="text-[11px] text-zinc-500 break-all">
                  <span className="text-zinc-600">in </span>
                  <span className="font-mono text-zinc-400">{commonPrefix}</span>
                </div>
              )}

              <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-green-500 font-medium">Keeping</div>
                <div className="font-mono text-xs text-green-400 break-all">
                  {stripPrefix(keepFile.path, commonPrefix)}
                </div>
              </div>

              <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-red-400 font-medium mb-1">
                  Deleting ({filesToDelete.length} file{filesToDelete.length !== 1 ? "s" : ""})
                </div>
                <div className="space-y-1">
                  {filesToDelete.map((f) => (
                    <div key={f.fileId} className="font-mono text-xs text-red-300/80 break-all">
                      {stripPrefix(f.path, commonPrefix)}
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
// Exclude folder dialog — adds a path to excluded_paths so the NEXT
// duplicate-detection run ignores every file at or under it.
// ---------------------------------------------------------------------------

function ExcludeFolderDialog({
  group,
  diskId,
  onClose,
}: {
  group: DuplicateGroup;
  diskId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const allPaths = group.files.map((f) => f.path);
  const commonPrefix = pathCommonPrefix(allPaths);
  const initialPath = commonPrefix
    ? commonPrefix.endsWith("/")
      ? commonPrefix.slice(0, -1)
      : commonPrefix
    : (() => {
        const p = allPaths[0] ?? "/";
        const slash = p.lastIndexOf("/");
        return slash > 0 ? p.slice(0, slash) : p;
      })();

  const [path, setPath] = useState(initialPath);
  const [reason, setReason] = useState("");

  const create = useMutation({
    mutationFn: (body: { path: string; reason?: string }) =>
      api.excludedPaths.create(diskId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["excludedPaths", diskId] });
      onClose();
    },
    onError: (err: any) => alert(`Add failed: ${err.message}`),
  });

  const submit = () => {
    const trimmed = path.trim();
    if (!trimmed.startsWith("/")) {
      alert("Path must be absolute (starts with /).");
      return;
    }
    create.mutate({ path: trimmed, reason: reason.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white">Exclude folder</h2>

        <p className="text-sm text-zinc-400">
          Every file at or under this path will be ignored on the next
          duplicate-detection run. Scan, diff, and copy are unaffected.
        </p>

        <div className="space-y-2">
          <label className="text-xs text-zinc-500">Path</label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-zinc-500">Reason (optional)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. self-contained archive with intentional duplicates"
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3 text-xs text-zinc-500">
          This duplicate group is from a past detection run and will stay
          visible until you re-run detection. The exclusion takes effect on
          the next run.
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={create.isPending || !path.trim()}
            onClick={submit}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40"
          >
            {create.isPending ? "Adding…" : "Add exclusion"}
          </button>
        </div>
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
  const liveDirs = group.directories.filter((d) => d.deletedAt === null);
  const keepDir = liveDirs.find((d) => d.directoryId === keepId) ?? null;
  const deleteCount = keepDir ? liveDirs.length - 1 : 0;

  const commonPrefix = pathCommonPrefix(group.directories.map((d) => d.path));

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

      {/* Single horizontal scroll container so prefix + all rows scroll as
          one block on narrow viewports, instead of each line scrolling alone. */}
      <div className="overflow-x-auto">
        {commonPrefix && (
          <div className="font-mono text-[11px] text-zinc-500 whitespace-nowrap pb-1">
            <span className="text-zinc-600">in </span>{commonPrefix}
          </div>
        )}
        <div className="space-y-1">
          {group.directories.map((d) => {
            const alreadyDeleted = d.deletedAt !== null;
            const remainder = stripPrefix(d.path, commonPrefix);
            return (
              <div key={d.directoryId} className="flex items-center gap-2 group">
                {alreadyDeleted ? (
                  <span
                    className="shrink-0 w-5 h-5 rounded border border-zinc-700 bg-zinc-800 text-xs flex items-center justify-center text-zinc-600"
                    title="Already deleted"
                  >
                    ×
                  </span>
                ) : group.canDelete ? (
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
                  className={`font-mono text-xs whitespace-nowrap hover:underline ${
                    alreadyDeleted
                      ? "text-zinc-600 line-through"
                      : keepId !== null && keepId !== d.directoryId
                        ? "text-red-400/70 line-through"
                        : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  title={d.path}
                >
                  {remainder}
                </a>
                {alreadyDeleted && (
                  <span className="text-[10px] text-zinc-600 font-medium shrink-0">DELETED</span>
                )}
                {!alreadyDeleted && keepId === d.directoryId && (
                  <span className="text-[10px] text-green-500 font-medium shrink-0">KEEP</span>
                )}
              </div>
            );
          })}
        </div>
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
      {!group.canDelete && liveDirs.length > 1 && (
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
  // If the cleanup mutation succeeds, we keep the dialog open and swap the
  // body to a live-progress view (using JobDetails) instead of navigating to
  // /jobs/:id. The disk page is the user's primary surface.
  const [startedJobId, setStartedJobId] = useState<number | null>(null);
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
  const commonPrefix = pathCommonPrefix([keepDir.path, ...deleteDirectories.map((m) => m.path)]);

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
      setStartedJobId(jobId);
    },
  });

  const errorMessage = cleanup.error instanceof Error ? cleanup.error.message : null;

  if (startedJobId != null) {
    return (
      <CleanupProgressDialogBody
        jobId={startedJobId}
        onClose={onClose}
      />
    );
  }

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
            {commonPrefix && (
              <div className="text-[11px] text-zinc-500 break-all">
                <span className="text-zinc-600">in </span>
                <span className="font-mono text-zinc-400">{commonPrefix}</span>
              </div>
            )}

            <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-green-500 font-medium">Keeping</div>
              <div className="font-mono text-xs text-green-400 break-all">
                {stripPrefix(keepDir.path, commonPrefix)}
              </div>
            </div>

            {deleteDirectories.map((m) => {
              const memberBlocked =
                !m.directoryExists || m.unknown.length > 0 || m.missing.length > 0;
              return (
                <div
                  key={m.directoryId}
                  className={
                    memberBlocked
                      ? "rounded-lg border border-amber-700/50 bg-amber-950/20"
                      : "rounded-lg border border-red-800/50 bg-red-950/20"
                  }
                >
                  <div className="px-4 py-3 text-xs flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div
                        className={
                          memberBlocked
                            ? "text-[10px] uppercase tracking-wider text-amber-400 font-medium"
                            : "text-[10px] uppercase tracking-wider text-red-400 font-medium"
                        }
                      >
                        {memberBlocked ? "Cannot delete — needs re-scan" : "Deleting directory"}
                      </div>
                      <div
                        className={
                          memberBlocked
                            ? "font-mono text-amber-300 break-all"
                            : "font-mono text-red-300 break-all"
                        }
                      >
                        {stripPrefix(m.path, commonPrefix)}
                      </div>
                    </div>
                    <span
                      className={
                        memberBlocked ? "text-amber-400/80 shrink-0" : "text-red-400/80 shrink-0"
                      }
                    >
                      {m.scanned.length + m.excluded.length} file
                      {m.scanned.length + m.excluded.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="px-4 pb-3 space-y-3 border-t border-red-800/30 pt-2">
                    {!m.directoryExists && (
                      <div className="text-[11px] text-amber-300/90 italic">
                        This folder is no longer on disk. Re-run duplicate detection to refresh the result.
                      </div>
                    )}

                    {m.scanned.length > 0 && (
                      <details>
                        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-300 select-none">
                          Show all {m.scanned.length} scan-recorded file{m.scanned.length === 1 ? "" : "s"}
                        </summary>
                        <div className="mt-1 space-y-0.5">
                          {m.scanned.map((f) => (
                            <div
                              key={`s-${f.fileId}`}
                              className="flex items-start gap-2 font-mono text-[11px] text-red-300/80"
                            >
                              <span className="flex-1 break-all">{f.relativePath}</span>
                              <span className="text-red-400/60 shrink-0">{formatBytes(f.sizeBytes)}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {m.excluded.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                          OS noise ({m.excluded.length}) — no keep-copy guardrail; review individually
                        </div>
                        <div className="space-y-0.5">
                          {m.excluded.map((f) => (
                            <div
                              key={`e-${f.relativePath}`}
                              className="flex items-start gap-2 font-mono text-[11px] text-zinc-400"
                            >
                              <span className="flex-1 break-all">{f.relativePath}</span>
                              <span className="text-zinc-500 shrink-0">{formatBytes(f.sizeBytes)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {m.unknown.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">
                          Unknown files — block deletion ({m.unknown.length})
                        </div>
                        <div className="space-y-0.5">
                          {m.unknown.map((f) => (
                            <div
                              key={`u-${f.relativePath}`}
                              className="flex items-start gap-2 font-mono text-[11px] text-amber-300"
                            >
                              <span className="flex-1 break-all">{f.relativePath}</span>
                              <span className="text-amber-400/60 shrink-0">{formatBytes(f.sizeBytes)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {m.missing.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">
                          Missing on disk — block deletion ({m.missing.length})
                        </div>
                        <div className="space-y-0.5">
                          {m.missing.map((f) => (
                            <div
                              key={`m-${f.fileId}`}
                              className="font-mono text-[11px] text-amber-300 break-all"
                            >
                              {f.relativePath}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
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
// Live progress for an in-flight directory cleanup job. Rendered both inline
// after the confirm dialog starts a job, and standalone when the user re-opens
// progress from the active-cleanup banner on the duplicates tab.
// ---------------------------------------------------------------------------

export function CleanupProgressDialogBody({
  jobId,
  onClose,
}: {
  jobId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { job, now, loading } = useLiveJob(jobId);

  const handlePause = async () => {
    await api.jobs.pause(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  };
  const handleResume = async () => {
    await api.jobs.resume(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  };
  const handleCancel = async () => {
    if (!confirm("Cancel this cleanup? Already-deleted files are not recovered.")) return;
    await api.jobs.cancel(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5 max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 shrink-0">
          <h2 className="text-base font-semibold text-white">Directory Cleanup</h2>
          <span className="text-xs text-zinc-600">#{jobId}</span>
        </div>

        <div className="overflow-y-auto pr-1 flex-1">
          {loading || !job ? (
            <div className="text-sm text-zinc-500">Loading job…</div>
          ) : (
            <JobDetails
              job={job}
              now={now}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
            />
          )}
        </div>

        <div className="flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="rounded bg-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-600 transition-colors"
          >
            Close
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
  const rawSort = useSearchParam("dirsort");
  const sort: DirSortOption =
    rawSort === "total_size" || rawSort === "directory_count" || rawSort === "file_count"
      ? rawSort
      : "wasted";
  const setSort = (s: DirSortOption) =>
    setSearchParams({ dirsort: s === "wasted" ? null : s, diroffset: null });

  const rawMinSize = useSearchParam("dirminsize");
  const minSize = rawMinSize ? Number(rawMinSize) : 0;
  const setMinSize = (n: number) =>
    setSearchParams({ dirminsize: n === 0 ? null : String(n), diroffset: null });

  const rawOffset = useSearchParam("diroffset");
  const offset = rawOffset ? Number(rawOffset) : 0;
  const setOffset = (n: number) =>
    setSearchParams({ diroffset: n === 0 ? null : String(n) });

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
          onChange={(e) => setSort(e.target.value as DirSortOption)}
          className={selectClass}
        >
          {(Object.keys(DIR_SORT_LABELS) as DirSortOption[]).map((k) => (
            <option key={k} value={k}>{DIR_SORT_LABELS[k]}</option>
          ))}
        </select>

        <select
          value={minSize}
          onChange={(e) => setMinSize(Number(e.target.value))}
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
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => setOffset(offset + PAGE_SIZE)}
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
  // URL-backed state — readers and setters mirror to ?d... query params on
  // the current page so filters/tab survive refresh, back/forward, and
  // shareable links. Default values are omitted from the URL to keep it tidy.
  const rawView = useSearchParam("dview");
  const viewMode: ViewMode = rawView === "directories" ? "directories" : "files";
  const setViewMode = (m: ViewMode) =>
    setSearchParams({ dview: m === "files" ? null : m });

  const rawSort = useSearchParam("dsort");
  const sort: SortOption =
    rawSort === "total_size" || rawSort === "file_count" || rawSort === "size"
      ? rawSort
      : "wasted";
  const setSort = (s: SortOption) =>
    setSearchParams({ dsort: s === "wasted" ? null : s, doffset: null });

  const rawMinSize = useSearchParam("dminsize");
  const minSize = rawMinSize ? Number(rawMinSize) : 0;
  const setMinSize = (n: number) =>
    setSearchParams({ dminsize: n === 0 ? null : String(n), doffset: null });

  const rawMinCopies = useSearchParam("dmincopies");
  const minCopies = rawMinCopies ? Number(rawMinCopies) : 2;
  const setMinCopies = (n: number) =>
    setSearchParams({ dmincopies: n === 2 ? null : String(n), doffset: null });

  const rawOffset = useSearchParam("doffset");
  const offset = rawOffset ? Number(rawOffset) : 0;
  const setOffset = (n: number) =>
    setSearchParams({ doffset: n === 0 ? null : String(n) });

  const [cleanupTarget, setCleanupTarget] = useState<{
    group: DuplicateGroup;
    keepFile: DuplicateGroupFile;
  } | null>(null);

  const [excludeTarget, setExcludeTarget] = useState<DuplicateGroup | null>(null);

  const queryClient = useQueryClient();

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
            onSort={setSort}
            minSize={minSize}
            onMinSize={setMinSize}
            minCopies={minCopies}
            onMinCopies={setMinCopies}
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
                        onExcludeRequest={setExcludeTarget}
                      />
                    ))}
                  </div>
                )}
              </div>

              {data.totalGroups > PAGE_SIZE && (
                <Pagination
                  offset={offset}
                  total={data.totalGroups}
                  onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  onNext={() => setOffset(offset + PAGE_SIZE)}
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

      {excludeTarget && (
        <ExcludeFolderDialog
          group={excludeTarget}
          diskId={diskId}
          onClose={() => setExcludeTarget(null)}
        />
      )}
    </div>
  );
}
