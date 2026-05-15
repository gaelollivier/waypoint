import type { CleanupResponse, Disk, DiffJobSummary, DiffTreeResponse, DuplicateDirectoriesResponse, DuplicateJobSummary, DuplicatesResponse, Job, JobEvent, TreeResponse } from "./types";

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

export const api = {
  disks: {
    list: () => request<Disk[]>("/disks"),

    get: (id: number) => request<Disk>(`/disks/${id}`),

    volumes: () => request<Array<{ name: string; mountPath: string; capacityBytes: number | null; freeBytes: number | null }>>("/disks/volumes"),

    register: (body: { mountPath: string; label: string }) =>
      request<Disk>("/disks", { method: "POST", body: JSON.stringify(body) }),

    update: (id: number, body: Partial<{ label: string; kind: "ssd" | "hdd" }>) =>
      request<Disk>(`/disks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

    scan: (id: number) =>
      request<{ jobId: number }>(`/disks/${id}/scan`, { method: "POST" }),

    writeSpeedTest: (id: number, body: { sizeBytes: number; mode: "null" | "random" }) =>
      request<{ jobId: number; filePath: string }>(`/disks/${id}/write-speed-test`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    readSpeedTest: (id: number, body?: { sampleCount?: number }) =>
      request<{ jobId: number }>(`/disks/${id}/read-speed-test`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),

    events: (
      id: number,
      params?: { level?: string; jobId?: number; limit?: number; offset?: number }
    ) => {
      const qs = params
        ? "?" + new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)])
          ).toString()
        : "";
      return request<JobEvent[]>(`/disks/${id}/events${qs}`);
    },
  },

  tree: {
    get: (
      diskId: number,
      opts?: { parentId?: number | null; parentPath?: string | null } | number | null
    ): Promise<TreeResponse> => {
      const params = new URLSearchParams();
      if (typeof opts === "number") {
        params.set("parentId", String(opts));
      } else if (opts?.parentId != null) {
        params.set("parentId", String(opts.parentId));
      } else if (opts?.parentPath) {
        params.set("parentPath", opts.parentPath);
      }
      const qs = params.toString() ? `?${params.toString()}` : "";
      return request<TreeResponse>(`/disks/${diskId}/tree${qs}`);
    },
  },

  diff: {
    start: (sourceDiskId: number, destDiskId: number) =>
      request<{ jobId: number }>(`/disks/${sourceDiskId}/diff`, {
        method: "POST",
        body: JSON.stringify({ destDiskId }),
      }),

    jobs: (sourceDiskId: number) =>
      request<DiffJobSummary[]>(`/disks/${sourceDiskId}/diff/jobs`),

    tree: (
      sourceDiskId: number,
      destDiskId: number,
      opts?: { parentPath?: string; diffJobId?: number }
    ): Promise<DiffTreeResponse> => {
      const params = new URLSearchParams({ destDiskId: String(destDiskId) });
      if (opts?.parentPath) params.set("parentPath", opts.parentPath);
      if (opts?.diffJobId != null) params.set("diffJobId", String(opts.diffJobId));
      return request<DiffTreeResponse>(`/disks/${sourceDiskId}/diff?${params}`);
    },
  },

  duplicates: {
    start: (diskId: number) =>
      request<{ jobId: number }>(`/disks/${diskId}/duplicates`, { method: "POST" }),

    jobs: (diskId: number) =>
      request<DuplicateJobSummary[]>(`/disks/${diskId}/duplicates/jobs`),

    cleanup: (
      diskId: number,
      body: {
        duplicateGroupId: number;
        keepFile: { fileId: number; path: string };
        deleteFiles: Array<{ fileId: number; path: string }>;
      }
    ) =>
      request<CleanupResponse>(`/disks/${diskId}/duplicates/cleanup`, {
        method: "POST",
        body: JSON.stringify({
          ...body,
          initiatedFromWebUI: true,
        }),
      }),

    directories: (
      diskId: number,
      opts?: {
        duplicateJobId?: number;
        sort?: "wasted" | "total_size" | "directory_count" | "file_count";
        minSize?: number;
        limit?: number;
        offset?: number;
      }
    ): Promise<DuplicateDirectoriesResponse> => {
      const params = new URLSearchParams();
      if (opts?.duplicateJobId != null) params.set("duplicateJobId", String(opts.duplicateJobId));
      if (opts?.sort) params.set("sort", opts.sort);
      if (opts?.minSize != null) params.set("minSize", String(opts.minSize));
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.offset != null) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<DuplicateDirectoriesResponse>(`/disks/${diskId}/duplicates/directories${qs ? "?" + qs : ""}`);
    },

    list: (
      diskId: number,
      opts?: {
        duplicateJobId?: number;
        sort?: "wasted" | "total_size" | "file_count" | "size";
        minSize?: number;
        minCopies?: number;
        limit?: number;
        offset?: number;
      }
    ): Promise<DuplicatesResponse> => {
      const params = new URLSearchParams();
      if (opts?.duplicateJobId != null) params.set("duplicateJobId", String(opts.duplicateJobId));
      if (opts?.sort) params.set("sort", opts.sort);
      if (opts?.minSize != null) params.set("minSize", String(opts.minSize));
      if (opts?.minCopies != null) params.set("minCopies", String(opts.minCopies));
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.offset != null) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<DuplicatesResponse>(`/disks/${diskId}/duplicates${qs ? "?" + qs : ""}`);
    },
  },

  copy: {
    start: (sourceDiskId: number, destDiskId: number, diffJobId: number) =>
      request<{ jobId: number }>("/copy", {
        method: "POST",
        body: JSON.stringify({ sourceDiskId, destDiskId, diffJobId }),
      }),
  },

  system: {
    openInFinder: (path: string) =>
      request<{ ok: boolean }>("/system/open-in-finder", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
  },

  jobs: {
    list: (params?: { status?: string; type?: string; targetDiskId?: number; limit?: number }) => {
      const qs = params
        ? "?" + new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)])
          ).toString()
        : "";
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
