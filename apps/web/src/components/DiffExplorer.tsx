import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { DiffEntry, DiffKind, DiffTreeResponse } from "../api/types";
import { formatBytes } from "../lib/format";
import { Tooltip } from "./Tooltip";

function useSearchParam(key: string): string | null {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("popstate", cb);
    return () => window.removeEventListener("popstate", cb);
  }, []);
  const getSnapshot = useCallback(
    () => new URLSearchParams(window.location.search).get(key),
    [key]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

function setSearchParam(key: string, value: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  history.pushState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ---------------------------------------------------------------------------
// Diff kind config
// ---------------------------------------------------------------------------

const KIND_CONFIG: Record<DiffKind, { label: string; dot: string; text: string; bar: string }> = {
  added:   { label: "Added",   dot: "bg-green-500",  text: "text-green-400",  bar: "bg-green-700" },
  changed: { label: "Changed", dot: "bg-yellow-500", text: "text-yellow-400", bar: "bg-yellow-700" },
  removed: { label: "Removed", dot: "bg-red-500",    text: "text-red-400",    bar: "bg-red-800" },
  present: { label: "Present", dot: "bg-zinc-600",   text: "text-zinc-400",   bar: "bg-zinc-700" },
};

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

type Filter = "all" | DiffKind;

function FilterBar({
  filter,
  onChange,
  page,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
  page: DiffTreeResponse;
}) {
  const tabs: Array<{ key: Filter; label: string; count: number; bytes: number; color: string }> = [
    {
      key: "all", label: "All",
      count: page.totalAdded + page.totalChanged + page.totalRemoved,
      bytes: page.totalAddedBytes + page.totalChangedBytes + page.totalRemovedBytes,
      color: "text-white",
    },
    { key: "added",   label: "Added",   count: page.totalAdded,   bytes: page.totalAddedBytes,   color: "text-green-400" },
    { key: "changed", label: "Changed", count: page.totalChanged, bytes: page.totalChangedBytes, color: "text-yellow-400" },
    { key: "removed", label: "Removed", count: page.totalRemoved, bytes: page.totalRemovedBytes, color: "text-red-400" },
  ];

  return (
    <div className="flex gap-1 flex-wrap">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            filter === t.key
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {t.key !== "all" && (
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${KIND_CONFIG[t.key as DiffKind].dot}`} />
          )}
          <span className={filter === t.key ? "text-white" : t.color}>{t.label}</span>
          <span className="text-zinc-600">{t.count.toLocaleString()}</span>
          <span className="text-zinc-700">{formatBytes(t.bytes)}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Directory aggregate pills
// ---------------------------------------------------------------------------

function DirAggregates({ entry }: { entry: DiffEntry }) {
  const parts: Array<{ color: string; count: number; bytes: number }> = [];
  if ((entry.addedCount ?? 0) > 0)
    parts.push({ color: "text-green-400", count: entry.addedCount!, bytes: entry.addedBytes! });
  if ((entry.changedCount ?? 0) > 0)
    parts.push({ color: "text-yellow-400", count: entry.changedCount!, bytes: entry.changedBytes! });
  if ((entry.removedCount ?? 0) > 0)
    parts.push({ color: "text-red-400", count: entry.removedCount!, bytes: entry.removedBytes! });

  if (parts.length === 0) return null;

  return (
    <span className="flex items-center gap-2">
      {parts.map((p, i) => (
        <span key={i} className={`text-xs font-mono ${p.color}`}>
          {p.count.toLocaleString()}<span className="text-zinc-700">/</span>{formatBytes(p.bytes)}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function DiffRow({
  entry,
  maxBytes,
  onEnter,
}: {
  entry: DiffEntry;
  maxBytes: number;
  onEnter: (entry: DiffEntry) => void;
}) {
  const isDir = entry.kind === "directory";
  const barPct = maxBytes > 0 ? (entry.sizeBytes / maxBytes) * 100 : 0;
  const fileCfg = entry.diffKind ? KIND_CONFIG[entry.diffKind] : null;

  const dirBarColor = isDir
    ? (entry.addedCount ?? 0) > 0 ? "bg-green-800"
    : (entry.changedCount ?? 0) > 0 ? "bg-yellow-800"
    : (entry.removedCount ?? 0) > 0 ? "bg-red-900"
    : "bg-zinc-700"
    : fileCfg?.bar ?? "bg-zinc-600";

  return (
    <div
      className={`flex items-center gap-3 px-4 group ${isDir ? "cursor-pointer hover:bg-zinc-800/60" : ""}`}
      style={{ minHeight: 52 }}
      onClick={() => isDir && onEnter(entry)}
    >
      <span className="text-base shrink-0 w-5 text-center select-none">
        {isDir ? "📁" : "📄"}
      </span>

      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`text-sm truncate ${
              isDir ? "text-blue-300 group-hover:text-blue-200" : fileCfg?.text ?? "text-zinc-400"
            }`}
            title={entry.path}
          >
            {entry.name}
          </span>

          <div className="flex items-center gap-3 shrink-0">
            {isDir ? (
              <DirAggregates entry={entry} />
            ) : fileCfg ? (
              <span className={`text-xs font-medium ${fileCfg.text}`}>
                {fileCfg.label}
              </span>
            ) : null}

            {isDir ? (() => {
              const afterCount = (entry.presentCount ?? 0) + (entry.addedCount ?? 0) + (entry.changedCount ?? 0);
              const afterBytes = (entry.presentBytes ?? 0) + (entry.addedBytes ?? 0) + (entry.changedBytes ?? 0);
              return (
                <span className="text-xs font-mono text-right leading-relaxed">
                  <span className="text-zinc-500">
                    {(entry.presentCount ?? 0).toLocaleString()}
                    <span className="text-zinc-700">/</span>
                    {formatBytes(entry.presentBytes ?? 0)}
                  </span>
                  <span className="text-zinc-700"> → </span>
                  <span className="text-zinc-300">
                    {afterCount.toLocaleString()}
                    <span className="text-zinc-700">/</span>
                    {formatBytes(afterBytes)}
                  </span>
                </span>
              );
            })() : (
              entry.diffKind === "changed" ? (
                <span className="text-xs font-mono text-right leading-relaxed">
                  <span className="text-zinc-500">
                    {formatBytes(entry.destSizeBytes ?? entry.sizeBytes)}
                  </span>
                  <span className="text-zinc-700"> → </span>
                  <span className="text-zinc-300">
                    {formatBytes(entry.sourceSizeBytes ?? entry.sizeBytes)}
                  </span>
                </span>
              ) : (
                <span className="text-xs font-mono text-zinc-500 w-16 text-right">
                  {formatBytes(entry.sizeBytes)}
                </span>
              )
            )}
          </div>
        </div>

        <div className="h-0.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full ${dirBarColor}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function Breadcrumb({
  crumbs,
  onNavigate,
}: {
  crumbs: DiffTreeResponse["breadcrumb"];
  onNavigate: (path: string | null) => void;
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
                onClick={() => onNavigate(crumb.path)}
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

const OPEN_IN_FINDER_TOOLTIP =
  "Only works when used on the Mac running the Waypoint server.";

function OpenInFinderButton({
  path,
  label,
}: {
  path: string | null;
  label: string;
}) {
  if (!path) {
    return (
      <Tooltip content={OPEN_IN_FINDER_TOOLTIP}>
        <button
          type="button"
          disabled
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-600"
        >
          {label}
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={OPEN_IN_FINDER_TOOLTIP}>
      <button
        type="button"
        onClick={() => {
          api.system.openInFinder(path).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            alert(`Could not open Finder: ${message}`);
          });
        }}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800 hover:text-white"
      >
        {label}
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Summary (top-right, next to breadcrumb)
// ---------------------------------------------------------------------------

function DiffSummary({ dir }: { dir: DiffTreeResponse["currentDir"] }) {
  const prevCount = dir.presentCount + dir.removedCount + dir.changedCount;
  const prevBytes = dir.presentBytes + dir.removedBytes + dir.changedBytes;
  const newCount  = dir.presentCount + dir.addedCount   + dir.changedCount;
  const newBytes  = dir.presentBytes + dir.addedBytes   + dir.changedBytes;

  return (
    <div className="flex items-center gap-3 text-xs font-mono shrink-0 leading-relaxed">
      {dir.addedCount > 0 && (
        <span className="text-green-400">+{dir.addedCount.toLocaleString()}</span>
      )}
      {dir.changedCount > 0 && (
        <span className="text-yellow-400">~{dir.changedCount.toLocaleString()}</span>
      )}
      {dir.removedCount > 0 && (
        <span className="text-red-400">−{dir.removedCount.toLocaleString()}</span>
      )}
      <span className="text-zinc-700">·</span>
      <span>
        <span className="text-zinc-500">
          {prevCount.toLocaleString()}
          <span className="text-zinc-700">/</span>
          {formatBytes(prevBytes)}
        </span>
        <span className="text-zinc-700"> → </span>
        <span className="text-zinc-300">
          {newCount.toLocaleString()}
          <span className="text-zinc-700">/</span>
          {formatBytes(newBytes)}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffExplorer — real data via React Query
// ---------------------------------------------------------------------------

export function DiffExplorer({
  sourceDiskId,
  destDiskId,
}: {
  sourceDiskId: number;
  destDiskId: number;
}) {
  const parentPath = useSearchParam("diffPath") ?? "/";
  const rawFilter = useSearchParam("diffFilter");
  const filter: Filter =
    rawFilter === "added" || rawFilter === "changed" || rawFilter === "removed"
      ? rawFilter
      : "all";

  const { data: page, isLoading, error } = useQuery<DiffTreeResponse>({
    queryKey: ["diff", sourceDiskId, destDiskId, parentPath],
    queryFn: () => api.diff.tree(sourceDiskId, destDiskId, { parentPath }),
    retry: false,
  });

  const navigate = (path: string | null) => {
    setSearchParam("diffPath", path === null || path === "/" ? null : path);
  };

  const setFilter = (next: Filter) => {
    setSearchParam("diffFilter", next === "all" ? null : next);
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
        Loading diff…
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

  if (!page) return null;

  const filteredEntries = page.entries.filter((e) => {
    if (filter === "all") return true;
    if (e.kind === "file") return e.diffKind === filter;
    if (filter === "added")   return (e.addedCount ?? 0) > 0;
    if (filter === "changed") return (e.changedCount ?? 0) > 0;
    if (filter === "removed") return (e.removedCount ?? 0) > 0;
    return true;
  });

  const maxBytes = filteredEntries[0]?.sizeBytes ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <Breadcrumb crumbs={page.breadcrumb} onNavigate={navigate} />
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <OpenInFinderButton path={page.sourceCurrentPath} label="Open Source" />
          <OpenInFinderButton path={page.destCurrentPath} label="Open Dest" />
          <DiffSummary dir={page.currentDir} />
        </div>
      </div>

      <FilterBar filter={filter} onChange={setFilter} page={page} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            No {filter === "all" ? "entries" : filter} here.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {filteredEntries.map((entry) => (
              <DiffRow
                key={entry.path}
                entry={entry}
                maxBytes={maxBytes}
                onEnter={(e) => navigate(e.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
