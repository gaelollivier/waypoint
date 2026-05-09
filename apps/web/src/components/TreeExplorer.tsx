import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type { TreeEntry, TreeResponse } from "../api/types";
import { formatBytes } from "../lib/format";


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
      style={{ minHeight: 44 }}
      onClick={() => isDir && onEnter(entry)}
    >
      <span className="text-base shrink-0 w-5 text-center select-none">
        {isDir ? "📁" : "📄"}
      </span>

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

        <div className="h-0.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isDir ? "bg-blue-700" : "bg-zinc-600"}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </div>

      {isDir && entry.fileCount != null && (
        <span className="text-xs text-zinc-600 shrink-0 w-20 text-right">
          {entry.fileCount.toLocaleString()} files
        </span>
      )}
    </div>
  );
}

function Breadcrumb({
  crumbs,
  onNavigate,
}: {
  crumbs: TreeResponse["breadcrumb"];
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

/**
 * Virtualized tree explorer for a disk. Uses window scroll so the whole page
 * scrolls naturally — no inner scrollbar.
 */
export function TreeExplorer({ diskId }: { diskId: number }) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dirId: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.tree.get(diskId, dirId);
      setTree(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [diskId]);

  useEffect(() => { load(null); }, [load]);

  const entries = tree?.entries ?? [];
  const maxBytes = entries[0]?.sizeBytes ?? 0;

  return (
    <div className="space-y-4">
      {tree && (
        <div className="flex items-center justify-between gap-4">
          <Breadcrumb crumbs={tree.breadcrumb} onNavigate={load} />
          <span className="text-xs text-zinc-600 shrink-0">
            {formatBytes(tree.totalSizeBytes)} total
          </span>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
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
          <div className="divide-y divide-zinc-800/60">
            {entries.map((entry) => (
              <EntryRow key={entry.path} entry={entry} maxBytes={maxBytes} onEnter={(e) => load(e.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
