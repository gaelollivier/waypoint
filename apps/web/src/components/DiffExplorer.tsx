import { useState } from "react";
import { formatBytes } from "../lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffKind = "added" | "changed" | "removed" | "present";

export interface DiffEntry {
  kind: "directory" | "file";
  name: string;
  path: string;
  sizeBytes: number;
  // For files: the diff classification
  diffKind?: DiffKind;
  // For directories: aggregate counts
  addedCount?: number;
  addedBytes?: number;
  changedCount?: number;
  changedBytes?: number;
  removedCount?: number;
  removedBytes?: number;
  presentCount?: number;
  presentBytes?: number;
  totalFileCount?: number;
}

export interface DiffTreePage {
  breadcrumb: Array<{ name: string; path: string | null }>;
  totalAdded: number;
  totalAddedBytes: number;
  totalChanged: number;
  totalChangedBytes: number;
  totalRemoved: number;
  totalRemovedBytes: number;
  totalPresent: number;
  totalPresentBytes: number;
  entries: DiffEntry[];
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_ROOT: DiffTreePage = {
  breadcrumb: [{ name: "MacBook SSD", path: null }],
  totalAdded: 1842,
  totalAddedBytes: 47_300_000_000,
  totalChanged: 214,
  totalChangedBytes: 8_100_000_000,
  totalRemoved: 37,
  totalRemovedBytes: 1_200_000_000,
  totalPresent: 102_501,
  totalPresentBytes: 3_320_000_000_000,
  entries: [
    {
      kind: "directory", name: "Photos Library", path: "/Photos Library",
      sizeBytes: 210_000_000_000,
      addedCount: 1204, addedBytes: 38_000_000_000,
      changedCount: 88, changedBytes: 3_200_000_000,
      removedCount: 0, removedBytes: 0,
      presentCount: 87_412, presentBytes: 168_000_000_000, totalFileCount: 88_704,
    },
    {
      kind: "directory", name: "Documents", path: "/Documents",
      sizeBytes: 12_400_000_000,
      addedCount: 431, addedBytes: 6_800_000_000,
      changedCount: 112, changedBytes: 4_700_000_000,
      removedCount: 5, removedBytes: 120_000_000,
      presentCount: 3_204, presentBytes: 1_200_000_000, totalFileCount: 3_752,
    },
    {
      kind: "directory", name: "Projects", path: "/Projects",
      sizeBytes: 8_900_000_000,
      addedCount: 207, addedBytes: 2_500_000_000,
      changedCount: 14, changedBytes: 200_000_000,
      removedCount: 32, removedBytes: 1_080_000_000,
      presentCount: 11_043, presentBytes: 5_800_000_000, totalFileCount: 11_296,
    },
    {
      kind: "directory", name: "Desktop", path: "/Desktop",
      sizeBytes: 3_100_000_000,
      addedCount: 0, addedBytes: 0,
      changedCount: 0, changedBytes: 0,
      removedCount: 0, removedBytes: 0,
      presentCount: 842, presentBytes: 3_100_000_000, totalFileCount: 842,
    },
    {
      kind: "file", name: "archive.zip", path: "/archive.zip",
      sizeBytes: 4_200_000_000,
      diffKind: "added",
    },
    {
      kind: "file", name: "notes.txt", path: "/notes.txt",
      sizeBytes: 28_000,
      diffKind: "changed",
    },
    {
      kind: "file", name: "old-backup.dmg", path: "/old-backup.dmg",
      sizeBytes: 890_000_000,
      diffKind: "removed",
    },
  ],
};

const MOCK_DOCUMENTS: DiffTreePage = {
  breadcrumb: [
    { name: "MacBook SSD", path: null },
    { name: "Documents", path: "/Documents" },
  ],
  totalAdded: 431,
  totalAddedBytes: 6_800_000_000,
  totalChanged: 112,
  totalChangedBytes: 4_700_000_000,
  totalRemoved: 5,
  totalRemovedBytes: 120_000_000,
  totalPresent: 3_204,
  totalPresentBytes: 890_000_000,
  entries: [
    {
      kind: "directory", name: "Taxes", path: "/Documents/Taxes",
      sizeBytes: 880_000_000,
      addedCount: 42, addedBytes: 880_000_000,
      changedCount: 0, changedBytes: 0,
      removedCount: 0, removedBytes: 0,
      presentCount: 18, presentBytes: 120_000_000, totalFileCount: 60,
    },
    {
      kind: "directory", name: "Work", path: "/Documents/Work",
      sizeBytes: 5_200_000_000,
      addedCount: 311, addedBytes: 5_100_000_000,
      changedCount: 98, changedBytes: 4_400_000_000,
      removedCount: 2, removedBytes: 80_000_000,
      presentCount: 2_840, presentBytes: 760_000_000, totalFileCount: 3_251,
    },
    {
      kind: "file", name: "Resume.pdf", path: "/Documents/Resume.pdf",
      sizeBytes: 420_000,
      diffKind: "changed",
    },
    {
      kind: "file", name: "Budget 2025.xlsx", path: "/Documents/Budget 2025.xlsx",
      sizeBytes: 1_200_000,
      diffKind: "added",
    },
    {
      kind: "file", name: "old-contract.pdf", path: "/Documents/old-contract.pdf",
      sizeBytes: 840_000,
      diffKind: "removed",
    },
    {
      kind: "file", name: "photo.jpg", path: "/Documents/photo.jpg",
      sizeBytes: 4_800_000,
      diffKind: "present",
    },
    {
      kind: "file", name: "scan001.pdf", path: "/Documents/scan001.pdf",
      sizeBytes: 2_100_000,
      diffKind: "present",
    },
  ],
};

const MOCK_PAGES: Record<string | "root", DiffTreePage> = {
  root: MOCK_ROOT,
  "/Documents": MOCK_DOCUMENTS,
};

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
  page: DiffTreePage;
}) {
  const tabs: Array<{ key: Filter; label: string; count: number; bytes: number; color: string }> = [
    { key: "all", label: "All", count: page.totalAdded + page.totalChanged + page.totalRemoved, bytes: page.totalAddedBytes + page.totalChangedBytes + page.totalRemovedBytes, color: "text-white" },
    { key: "added", label: "Added", count: page.totalAdded, bytes: page.totalAddedBytes, color: "text-green-400" },
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
// Directory aggregate pill row
// ---------------------------------------------------------------------------

function DirAggregates({ entry }: { entry: DiffEntry }) {
  const parts: Array<{ color: string; count: number; bytes: number }> = [];
  if ((entry.addedCount ?? 0) > 0)
    parts.push({ color: "text-green-400", count: entry.addedCount!, bytes: entry.addedBytes! });
  if ((entry.changedCount ?? 0) > 0)
    parts.push({ color: "text-yellow-400", count: entry.changedCount!, bytes: entry.changedBytes! });
  if ((entry.removedCount ?? 0) > 0)
    parts.push({ color: "text-red-400", count: entry.removedCount!, bytes: entry.removedBytes! });

  const afterBytes =
    (entry.presentBytes ?? 0) + (entry.addedBytes ?? 0) + (entry.changedBytes ?? 0);

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
  const hasChanges = isDir && (
    (entry.addedCount ?? 0) + (entry.changedCount ?? 0) + (entry.removedCount ?? 0) > 0
  );

  // For directories, the bar color reflects the dominant diff kind
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
      {/* Icon */}
      <span className="text-base shrink-0 w-5 text-center select-none">
        {isDir ? "📁" : "📄"}
      </span>

      {/* Name + bar + meta */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          {/* Name */}
          <span
            className={`text-sm truncate ${
              isDir
                ? "text-blue-300 group-hover:text-blue-200"
                : fileCfg?.text ?? "text-zinc-400"
            }`}
            title={entry.path}
          >
            {entry.name}
          </span>

          {/* Right side */}
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
                  <span className="text-zinc-500">{(entry.presentCount ?? 0).toLocaleString()}<span className="text-zinc-700">/</span>{formatBytes(entry.presentBytes ?? 0)}</span>
                  <span className="text-zinc-700"> → </span>
                  <span className="text-zinc-300">{afterCount.toLocaleString()}<span className="text-zinc-700">/</span>{formatBytes(afterBytes)}</span>
                </span>
              );
            })() : (
              <span className="text-xs font-mono text-zinc-500 w-16 text-right">
                {formatBytes(entry.sizeBytes)}
              </span>
            )}
          </div>
        </div>

        {/* Size bar */}
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
  crumbs: DiffTreePage["breadcrumb"];
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

// ---------------------------------------------------------------------------
// DiffExplorer
// ---------------------------------------------------------------------------

export function DiffExplorer() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const page = MOCK_PAGES[currentPath ?? "root"] ?? MOCK_ROOT;

  const filteredEntries = page.entries.filter((e) => {
    if (filter === "all") return true;
    if (e.kind === "file") return e.diffKind === filter;
    if (filter === "added") return (e.addedCount ?? 0) > 0;
    if (filter === "changed") return (e.changedCount ?? 0) > 0;
    if (filter === "removed") return (e.removedCount ?? 0) > 0;
    return true;
  });

  const maxBytes = filteredEntries[0]?.sizeBytes ?? 0;

  const navigate = (path: string | null) => {
    setCurrentPath(path);
    setFilter("all");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <Breadcrumb crumbs={page.breadcrumb} onNavigate={navigate} />
        <div className="flex items-center gap-3 text-xs shrink-0">
          <span className="text-green-400">+{page.totalAdded.toLocaleString()}</span>
          <span className="text-yellow-400">~{page.totalChanged.toLocaleString()}</span>
          <span className="text-red-400">−{page.totalRemoved.toLocaleString()}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-400">
            → {formatBytes(page.totalPresentBytes + page.totalAddedBytes + page.totalChangedBytes)}
          </span>
        </div>
      </div>

      <FilterBar filter={filter} onChange={setFilter} page={page} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            No {filter === "all" ? "changes" : filter} entries here.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {filteredEntries.map((entry) => (
              <DiffRow key={entry.path} entry={entry} maxBytes={maxBytes} onEnter={(e) => navigate(e.path)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
