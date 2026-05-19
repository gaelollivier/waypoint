import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ExcludedPath, ExcludedPathsResponse } from "../api/types";
import { formatDate } from "../lib/format";

/**
 * Per-disk exclusion list for duplicate detection.
 *
 * Adding a directory here causes the next duplicate-detection run to ignore
 * every file at or under it — both in the GROUP BY (so groups don't form
 * from purely-excluded files) and in the per-group member list (so an
 * excluded copy never appears alongside a non-excluded sibling). Exclusions
 * do NOT affect scan, diff, or copy.
 */
export function ExcludedPathsSection({ diskId }: { diskId: number }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ExcludedPathsResponse>({
    queryKey: ["excludedPaths", diskId],
    queryFn: () => api.excludedPaths.list(diskId),
  });

  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const [draftReason, setDraftReason] = useState("");

  const create = useMutation({
    mutationFn: (body: { path: string; reason?: string }) =>
      api.excludedPaths.create(diskId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["excludedPaths", diskId] });
      setAdding(false);
      setDraftPath("");
      setDraftReason("");
    },
    onError: (err: any) => alert(`Add failed: ${err.message}`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.excludedPaths.delete(diskId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["excludedPaths", diskId] });
    },
    onError: (err: any) => alert(`Delete failed: ${err.message}`),
  });

  const submit = () => {
    const path = draftPath.trim();
    if (!path.startsWith("/")) {
      alert("Path must be absolute (starts with /).");
      return;
    }
    create.mutate({ path, reason: draftReason.trim() || undefined });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-white">Excluded paths</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Duplicate detection ignores every file at or under these paths.
            Scan, diff, and copy are unaffected.
          </p>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            Add exclusion
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
          <input
            type="text"
            value={draftPath}
            onChange={(e) => setDraftPath(e.target.value)}
            placeholder="/absolute/path/to/directory"
            spellCheck={false}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <input
            type="text"
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setAdding(false);
                setDraftPath("");
                setDraftReason("");
              }}
              className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!draftPath.trim() || create.isPending}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40"
            >
              {create.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-zinc-600">Loading…</p>
      ) : !data || data.exclusions.length === 0 ? (
        <p className="text-xs text-zinc-600">
          No exclusions yet. Add a path above, or use the “Exclude folder”
          button on a duplicate-group card.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
          {data.exclusions.map((e) => (
            <ExcludedPathRow
              key={e.id}
              exclusion={e}
              onDelete={() => {
                if (confirm(`Remove exclusion for ${e.path}?`)) remove.mutate(e.id);
              }}
              busy={remove.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExcludedPathRow({
  exclusion,
  onDelete,
  busy,
}: {
  exclusion: ExcludedPath;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="px-3 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-zinc-200 break-all">{exclusion.path}</div>
        {exclusion.reason && (
          <div className="text-xs text-zinc-500 mt-0.5 break-words">{exclusion.reason}</div>
        )}
        <div className="text-[10px] text-zinc-600 mt-0.5">
          Added {formatDate(exclusion.createdAt)}
        </div>
      </div>
      <button
        onClick={onDelete}
        disabled={busy}
        className="shrink-0 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 transition-colors disabled:opacity-40"
      >
        Remove
      </button>
    </li>
  );
}
