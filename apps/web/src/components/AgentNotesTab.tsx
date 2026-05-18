import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AgentNotes } from "../api/types";
import { formatDate } from "../lib/format";

/**
 * Freeform markdown editor for the disk's agent-cleanup notes. An LLM agent
 * fills in keep/delete rules here from past deletion patterns; the user
 * reviews and iterates. Stored as a single string blob per disk.
 */
export function AgentNotesTab({ diskId }: { diskId: number }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<AgentNotes>({
    queryKey: ["agentNotes", diskId],
    queryFn: () => api.cleanup.getNotes(diskId),
  });

  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (data && draft === null) setDraft(data.body);
  }, [data, draft]);

  const save = useMutation({
    mutationFn: (body: string) => api.cleanup.putNotes(diskId, body),
    onSuccess: (res) => {
      qc.setQueryData(["agentNotes", diskId], res);
      setDraft(res.body);
    },
    onError: (err: any) => alert(`Save failed: ${err.message}`),
  });

  if (isLoading || draft === null) {
    return <p className="text-sm text-zinc-500 p-4">Loading…</p>;
  }

  const dirty = draft !== (data?.body ?? "");

  return (
    <div className="space-y-3">
      <div className="text-sm text-zinc-400">
        Freeform markdown. Agents read this for context when generating cleanup
        suggestions; you can refine the rules here over time. Nothing here ever
        triggers a deletion on its own.
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={SAMPLE_RULES}
        className="w-full min-h-[60vh] rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        spellCheck={false}
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-zinc-500">
          {data?.updatedAt ? `Last saved ${formatDate(data.updatedAt)}` : "Not saved yet"}
        </div>
        <button
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-zinc-800 disabled:text-zinc-500 enabled:hover:bg-blue-500 min-h-[44px]"
        >
          {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}

const SAMPLE_RULES = `# Cleanup rules

Write the rules an agent should follow when proposing which duplicate to
keep vs delete. Examples:

- Prefer the copy in /Photos/<year>/ over copies in /Downloads/
- For video files, keep the one with the longer filename (usually descriptive)
- Never delete anything inside /Archive/ — always keep that one
`;
