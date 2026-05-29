import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Link } from "../components/Router";
import { formatDate } from "../lib/format";
import type { ComparisonBatchSummary, ComparisonProgress } from "../api/types";

function progressBar(p: ComparisonProgress) {
  const total = Math.max(1, p.total);
  const verdicted = p.same + p.different + p.unsure;
  const pct = (verdicted / total) * 100;
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden flex">
        <div className="h-full bg-emerald-600" style={{ width: `${(p.same / total) * 100}%` }} />
        <div className="h-full bg-rose-600" style={{ width: `${(p.different / total) * 100}%` }} />
        <div className="h-full bg-amber-600" style={{ width: `${(p.unsure / total) * 100}%` }} />
      </div>
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{verdicted}/{p.total} reviewed ({pct.toFixed(0)}%)</span>
        <span className="flex gap-3">
          <span className="text-emerald-400">{p.same} same</span>
          <span className="text-rose-400">{p.different} different</span>
          <span className="text-amber-400">{p.unsure} unsure</span>
        </span>
      </div>
    </div>
  );
}

function BatchCard({ batch }: { batch: ComparisonBatchSummary }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.comparisons.remove(batch.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["comparisons"] }),
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href={`/compare/${batch.id}`}
            className="font-medium text-white hover:underline"
          >
            {batch.name}
          </Link>
          <div className="mt-1 text-xs text-zinc-500">
            Created {formatDate(batch.createdAt)} · {batch.progress.total} pair
            {batch.progress.total === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={() => {
            if (confirm(`Delete batch "${batch.name}"? This removes all verdicts in it.`)) {
              remove.mutate();
            }
          }}
          className="text-xs text-zinc-500 hover:text-rose-400 transition-colors"
          disabled={remove.isPending}
        >
          Delete
        </button>
      </div>

      {batch.rationale && (
        <p className="text-xs text-zinc-400 whitespace-pre-wrap">{batch.rationale}</p>
      )}

      {progressBar(batch.progress)}
    </div>
  );
}

export function ComparePage() {
  const { data, isLoading } = useQuery({
    queryKey: ["comparisons"],
    queryFn: api.comparisons.list,
    refetchInterval: 10_000,
  });

  const batches = data?.batches ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Comparisons</h1>
      </div>

      <p className="text-xs text-zinc-500">
        Side-by-side review of media pairs. Batches are created by the cleanup agent;
        open one to verdict each pair as <span className="text-emerald-400">same</span>,{" "}
        <span className="text-rose-400">different</span>, or{" "}
        <span className="text-amber-400">unsure</span>.
      </p>

      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : batches.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
          <p className="text-sm text-zinc-400">No comparison batches yet.</p>
          <p className="text-xs text-zinc-600">
            Ask the agent to create one via <code>POST /api/comparisons</code>.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {batches.map((b) => (
            <BatchCard key={b.id} batch={b} />
          ))}
        </div>
      )}
    </div>
  );
}
