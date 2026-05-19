import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  CleanupSuggestion,
  CleanupSuggestionMember,
  CleanupSuggestionsResponse,
} from "../api/types";
import { formatBytes } from "../lib/format";
import { pathCommonPrefix, stripPrefix } from "./DuplicateExplorer";

/**
 * Agent-generated cleanup suggestions for one disk. A suggestion is a
 * BATCH of one or more members — Apply runs the entire batch through one
 * server-side endpoint that holds the disk write lock once. The same
 * browser-UA + initiatedFromWebUI guardrails apply as for manual cleanup.
 *
 * Singleton batches still render as a single-member card; multi-member
 * batches render their members under a shared prefix so the user can scan
 * the file list without horizontal scrolling.
 */
export function CleanupSuggestionsTab({ diskId }: { diskId: number }) {
  const [statusFilter, setStatusFilter] = useState<"pending" | "applied" | "dismissed">("pending");

  const { data, isLoading } = useQuery<CleanupSuggestionsResponse>({
    queryKey: ["cleanupSuggestions", diskId, statusFilter],
    queryFn: () => api.cleanup.suggestions(diskId, { status: statusFilter, limit: 100 }),
  });

  if (isLoading) return <p className="text-sm text-zinc-500 p-4">Loading…</p>;
  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm text-zinc-400">
          Agent-generated suggestions. Apply runs through the same
          guardrailed deletion path as manual cleanup, but for a whole batch
          at once. Re-running a scan doesn't reset pending suggestions —
          each member re-resolves against the latest detection.
        </div>
      </div>

      <div className="flex gap-1 text-xs">
        {(["pending", "applied", "dismissed"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-md px-3 py-1.5 capitalize min-h-[36px] ${
              statusFilter === s
                ? "bg-zinc-700 text-white"
                : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {s} {statusFilter === s ? `(${data.total})` : ""}
          </button>
        ))}
      </div>

      {data.suggestions.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          {statusFilter === "pending"
            ? "No pending suggestions. An agent can POST to /api/disks/" + diskId + "/cleanup/suggestions to add some."
            : `No ${statusFilter} suggestions.`}
        </div>
      ) : (
        <ul className="space-y-3">
          {data.suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              diskId={diskId}
              suggestion={s}
              actionable={statusFilter === "pending"}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SuggestionCard({
  diskId,
  suggestion,
  actionable,
}: {
  diskId: number;
  suggestion: CleanupSuggestion;
  actionable: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["cleanupSuggestions", diskId] });

  const apply = useMutation({
    mutationFn: () => api.cleanup.apply(diskId, suggestion.id),
    onSuccess: invalidate,
    onError: (err: any) => alert(`Apply failed: ${err.message}`),
  });

  const dismiss = useMutation({
    mutationFn: () => api.cleanup.markDismissed(diskId, suggestion.id),
    onSuccess: invalidate,
    onError: (err: any) => alert(`Dismiss failed: ${err.message}`),
  });

  const busy = apply.isPending || dismiss.isPending;
  const filesToDelete = suggestion.members.reduce(
    (sum, m) => sum + m.deletePaths.length,
    0
  );

  // Build the shared prefix across every path in every member so the
  // rendered list reads vertically without horizontal scroll on long
  // /Volumes/.../... trees.
  const allPaths = suggestion.members.flatMap((m) => [m.keepPath, ...m.deletePaths]);
  const prefix = pathCommonPrefix(allPaths);
  const isBatch = suggestion.memberCount > 1;

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm text-zinc-200">
          <span className="font-semibold text-emerald-400">
            Free {formatBytes(suggestion.totalWastedBytes)}
          </span>
          <span className="text-zinc-500">
            {" "}— {isBatch
              ? `batch of ${suggestion.memberCount} files, delete ${filesToDelete}`
              : `delete ${filesToDelete} of ${filesToDelete + 1} ${formatBytes(suggestion.members[0].sizeBytes)} cop${filesToDelete === 1 ? "y" : "ies"}`}
          </span>
        </div>
        {isBatch && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
            batch
          </span>
        )}
      </div>

      <div className="space-y-1.5 text-xs font-mono overflow-x-auto">
        {prefix && (
          <div className="text-[11px] text-zinc-500 whitespace-nowrap pb-0.5">
            <span className="text-zinc-600">in </span>{prefix}
          </div>
        )}
        {suggestion.members.map((m, idx) => (
          <MemberRows
            key={m.id}
            member={m}
            prefix={prefix}
            isFirst={idx === 0}
            isBatch={isBatch}
          />
        ))}
      </div>

      {suggestion.rationale && (
        <div className="text-xs italic text-zinc-400 border-l-2 border-zinc-700 pl-2">
          {suggestion.rationale}
        </div>
      )}

      {actionable && !suggestion.allResolved && (
        <div className="text-xs text-amber-400">
          Stale: one or more members can't be resolved against the latest
          scan (see member badges). Apply is disabled.
        </div>
      )}

      {actionable && (
        <div className="flex gap-2">
          <button
            onClick={() => apply.mutate()}
            disabled={!suggestion.allResolved || busy}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white disabled:bg-zinc-800 disabled:text-zinc-500 enabled:hover:bg-emerald-500 min-h-[44px]"
          >
            {apply.isPending
              ? <Spinner label={isBatch ? "Applying batch…" : "Applying…"} />
              : isBatch
                ? `Apply batch (${filesToDelete} files)`
                : "Apply"}
          </button>
          <button
            onClick={() => dismiss.mutate()}
            disabled={busy}
            className="flex-1 rounded-md bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 disabled:opacity-50 enabled:hover:bg-zinc-700 min-h-[44px]"
          >
            {dismiss.isPending ? <Spinner label="Dismissing…" /> : "Dismiss"}
          </button>
        </div>
      )}
    </li>
  );
}

function MemberRows({
  member,
  prefix,
  isFirst,
  isBatch,
}: {
  member: CleanupSuggestionMember;
  prefix: string;
  isFirst: boolean;
  isBatch: boolean;
}) {
  return (
    <div className={isBatch && !isFirst ? "pt-2 border-t border-zinc-800/50" : ""}>
      <PathRow kind="keep" path={stripPrefix(member.keepPath, prefix)} />
      {member.deletePaths.map((p) => (
        <PathRow key={p} kind="delete" path={stripPrefix(p, prefix)} />
      ))}
      {!member.resolved && (
        <div className="text-[11px] text-amber-400 pl-2 pt-0.5">
          stale: {member.staleReason ?? "cannot resolve against latest scan"}
        </div>
      )}
    </div>
  );
}

function PathRow({ kind, path }: { kind: "keep" | "delete"; path: string }) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
          kind === "keep"
            ? "bg-emerald-950 text-emerald-400"
            : "bg-red-950 text-red-400"
        }`}
      >
        {kind}
      </span>
      <span className={kind === "keep" ? "text-zinc-200" : "text-zinc-400"}>
        {path}
      </span>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center justify-center gap-2">
      <svg
        className="animate-spin h-4 w-4"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {label}
    </span>
  );
}
