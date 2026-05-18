import type { AgentNotes, CleanupResponse, CleanupSuggestionsResponse, DeletionHistoryResponse, DirectoryGroupFilesResponse, DirectoryGroupInventoryResponse, Disk, DiffJobSummary, DiffTreeResponse, DuplicateDirectoriesResponse, DuplicateJobSummary, DuplicateScanSummary, DuplicatesResponse, Job, JobEvent, TreeResponse } from "./types";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as any).error ?? `HTTP ${res.status}`,
      res.status,
      body
    );
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

    scan: (id: number, body?: { fullHash?: boolean }) =>
      request<{ jobId: number }>(`/disks/${id}/scan`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),

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
    start: (diskId: number, body?: { scanId?: number }) =>
      request<{ jobId: number }>(`/disks/${diskId}/duplicates`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),

    scans: (diskId: number) =>
      request<DuplicateScanSummary[]>(`/disks/${diskId}/duplicates/scans`),

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

    directoryGroupFiles: (diskId: number, groupId: number) =>
      request<DirectoryGroupFilesResponse>(
        `/disks/${diskId}/duplicates/directories/${groupId}/files`
      ),

    directoryGroupInventory: (diskId: number, groupId: number) =>
      request<DirectoryGroupInventoryResponse>(
        `/disks/${diskId}/duplicates/directories/${groupId}/inventory`
      ),

    directoryCleanup: (
      diskId: number,
      body: {
        duplicateDirectoryGroupId: number;
        keepDirectory: { directoryId: number; path: string };
        deleteDirectories: Array<{
          directoryId: number;
          path: string;
          files: Array<{ fileId: number; relativePath: string }>;
          excludedFiles?: Array<{ relativePath: string }>;
        }>;
      }
    ) =>
      request<{ jobId: number }>(`/disks/${diskId}/duplicates/directories/cleanup`, {
        method: "POST",
        body: JSON.stringify({ ...body, initiatedFromWebUI: true }),
      }),

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

  cleanup: {
    history: (diskId: number, opts?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.offset != null) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<DeletionHistoryResponse>(
        `/disks/${diskId}/cleanup/history${qs ? "?" + qs : ""}`
      );
    },

    getNotes: (diskId: number) =>
      request<AgentNotes>(`/disks/${diskId}/cleanup/notes`),

    putNotes: (diskId: number, body: string) =>
      request<AgentNotes>(`/disks/${diskId}/cleanup/notes`, {
        method: "PUT",
        body: JSON.stringify({ body }),
      }),

    suggestions: (diskId: number, opts?: { status?: "pending" | "applied" | "dismissed" | "all"; limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.offset != null) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<CleanupSuggestionsResponse>(
        `/disks/${diskId}/cleanup/suggestions${qs ? "?" + qs : ""}`
      );
    },

    createSuggestion: (
      diskId: number,
      body: {
        contentHash: string;
        keepPath: string;
        deletePaths: string[];
        sizeBytes: number;
        rationale?: string;
      }
    ) =>
      request<{ id: number; diskId: number }>(`/disks/${diskId}/cleanup/suggestions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    markApplied: (diskId: number, suggestionId: number) =>
      request<{ id: number; status: "applied"; appliedAt: string }>(
        `/disks/${diskId}/cleanup/suggestions/${suggestionId}/applied`,
        { method: "POST" }
      ),

    markDismissed: (diskId: number, suggestionId: number) =>
      request<{ id: number; status: "dismissed"; dismissedAt: string }>(
        `/disks/${diskId}/cleanup/suggestions/${suggestionId}/dismissed`,
        { method: "POST" }
      ),
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
