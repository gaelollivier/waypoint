import type { Disk, Job, JobEvent } from "./types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Disks ────────────────────────────────────────────────────────────────────

export const api = {
  disks: {
    list: () => request<Disk[]>("/disks"),

    register: (body: { mountPath: string; label: string; kind: "ssd" | "hdd"; role: "source" | "destination" }) =>
      request<Disk>("/disks", { method: "POST", body: JSON.stringify(body) }),

    update: (id: number, body: Partial<{ label: string; kind: "ssd" | "hdd"; role: "source" | "destination" }>) =>
      request<Disk>(`/disks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

    scan: (id: number) =>
      request<{ jobId: number }>(`/disks/${id}/scan`, { method: "POST" }),
  },

  jobs: {
    list: (params?: { status?: string; type?: string; limit?: number }) => {
      const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
      return request<Job[]>(`/jobs${qs}`);
    },

    get: (id: number) => request<Job>(`/jobs/${id}`),

    events: (id: number, limit = 200) =>
      request<JobEvent[]>(`/jobs/${id}/events-log?limit=${limit}`),

    pause: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/pause`, { method: "POST" }),
    resume: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/resume`, { method: "POST" }),
    cancel: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: "POST" }),

    /** Opens an SSE connection for live job progress. Returns a cleanup fn. */
    stream: (id: number, onEvent: (event: string, data: unknown) => void): (() => void) => {
      const es = new EventSource(`/api/jobs/${id}/events`);
      const handler = (e: MessageEvent) => {
        try { onEvent(e.type, JSON.parse(e.data)); } catch {}
      };
      for (const evt of ["snapshot", "status", "progress"]) {
        es.addEventListener(evt, handler as EventListener);
      }
      return () => es.close();
    },
  },
};
