import { useState, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../api/client";
import type { TreeEntry, TreeResponse } from "../api/types";
import { navigate } from "../components/Router";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

// ── Row component ─────────────────────────────────────────────────────────────

const ROW_HEIGHT = 44;

function EntryRow({
  entry,
  maxBytes,
  onEnter,
}: {
  entry: TreeEntry;
  maxBytes: number;
  onEnter: (entry: TreeEntry) => void;
}) {
  const barPct = maxBytes > 0 ? (entry.sizeBytes / maxBytes) * 100 : 0;
  const isDir = entry.kind === "directory";

  return (
    <div
      className={`flex items-center gap-3 px-4 group ${isDir ? "cursor-pointer hover:bg-zinc-800/60" : ""}`}
      style={{ height: ROW_HEIGHT }}
      onClick={() => isDir && onEnter(entry)}
    >
      {/* Icon */}
      <span className="text-base shrink-0 w-5 text-center select-none">
        {isDir ? "📁" : "📄"}
      </span>

      {/* Name + size bar */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-sm truncate ${isDir ? "text-blue-300 group-hover:text-blue-200" : "text-zinc-300"}`}
            title={entry.path}
          >
            {entry.name}
          </span>
          <span className="text-xs font-mono text-zinc-500 shrink-0">
            {formatBytes(entry.sizeBytes)}
          </span>
        </div>

        {/* Size bar */}
        <div className="h-0.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isDir ? "bg-blue-700" : "bg-zinc-600"}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </div>

      {/* File count (dirs only) */}
      {isDir && entry.fileCount != null && (
        <span className="text-xs text-zinc-600 shrink-0 w-20 text-right">
          {entry.fileCount.toLocaleString()} files
        </span>
      )}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function Breadcrumb({
  crumbs,
  diskId,
  onNavigate,
}: {
  crumbs: TreeResponse["breadcrumb"];
  diskId: number;
  onNavigate: (dirId: number | null) => void;
}) {
  return (
    <nav className="flex items-center gap-1 text-sm min-w-0 overflow-x-auto">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 shrink-0">
            {i > 0 && <span className="text-zinc-700">/</span>}
            {isLast ? (
              <span className="text-white font-medium">{crumb.name}</span>
            ) : (
              <button
                onClick={() => onNavigate(crumb.id)}
                className="text-zinc-400 hover:text-white transition-colors"
              >
                {crumb.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function DiskExplorerPage({ id }: { id: string }) {
  const diskId = Number(id);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentDirId, setCurrentDirId] = useState<number | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dirId: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.tree.get(diskId, dirId);
      setTree(data);
      setCurrentDirId(dirId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [diskId]);

  useEffect(() => { load(null); }, [load]);

  const handleEnter = (entry: TreeEntry) => {
    if (entry.kind !== "directory") return;
    load(entry.id);
  };

  const handleBreadcrumb = (dirId: number | null) => {
    // null = disk root (re-load with no parentId)
    if (dirId === null) {
      load(null);
    } else {
      load(dirId);
    }
  };

  const entries = tree?.entries ?? [];
  const maxBytes = entries[0]?.sizeBytes ?? 0; // already sorted largest-first

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div className="max-w-4xl mx-auto space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => navigate(`/disks/${diskId}`)}
          className="text-xs text-zinc-500 hover:text-white transition-colors"
        >
          ← Back to disk
        </button>
        {tree && (
          <span className="text-xs text-zinc-600">
            {formatBytes(tree.totalSizeBytes)} total
          </span>
        )}
      </div>

      {/* Breadcrumb */}
      {tree && (
        <Breadcrumb
          crumbs={tree.breadcrumb}
          diskId={diskId}
          onNavigate={handleBreadcrumb}
        />
      )}

      {/* Content */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 flex-1 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            Loading…
          </div>
        )}

        {error && (
          <div className="p-6 text-sm text-red-400">{error}</div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            {tree?.totalSizeBytes === 0
              ? "This disk hasn't been scanned yet."
              : "Empty directory"}
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <div
            ref={parentRef}
            className="h-[calc(100vh-240px)] overflow-y-auto divide-y divide-zinc-800/60"
          >
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const entry = entries[vItem.index];
                return (
                  <div
                    key={vItem.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <EntryRow
                      entry={entry}
                      maxBytes={maxBytes}
                      onEnter={handleEnter}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
