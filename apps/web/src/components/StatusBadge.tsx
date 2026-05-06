import type { Job } from "../api/types";

const COLORS: Record<Job["status"], string> = {
  queued:    "bg-zinc-700 text-zinc-300",
  running:   "bg-blue-900 text-blue-300",
  paused:    "bg-yellow-900 text-yellow-300",
  completed: "bg-green-900 text-green-300",
  failed:    "bg-red-900 text-red-300",
  cancelled: "bg-zinc-700 text-zinc-400",
};

export function StatusBadge({ status }: { status: Job["status"] }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-mono font-medium ${COLORS[status]}`}>
      {status}
    </span>
  );
}
