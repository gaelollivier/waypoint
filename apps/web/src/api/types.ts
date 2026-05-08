export interface Disk {
  id: number;
  diskUuid: string;
  label: string | null;
  kind: "ssd" | "hdd";
  capacityBytes: number | null;
  freeBytes: number | null;
  mountPath: string | null;
  isConnected: boolean;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  lastBackupAt: string | null;
  lastVerifyAt: string | null;
}

export interface Volume {
  mountPath: string;
  name: string;
  capacityBytes: number | null;
  freeBytes: number | null;
  isWaypointDisk: boolean;
}

export interface Job {
  id: number;
  type: "scan" | "copy" | "verify" | "backup";
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: string | null;
  parentJobId: number | null;
  targetDiskId: number | null;
  sourceDiskId: number | null;
  destDiskId: number | null;
  bytesProcessed: number;
  itemsProcessed: number;
  warningsCount: number;
  nonCriticalErrorsCount: number;
  errorsCount: number;
  progressJson: Record<string, unknown> | null;
  createdBy: "user" | "composite";
  createdAt: string;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface TreeEntry {
  kind: "directory" | "file";
  id: number;
  name: string;
  path: string;
  sizeBytes: number;
  fileCount?: number;
  directFileCount?: number;
  mtime?: string;
  sampledHash?: string | null;
}

export interface TreeResponse {
  diskId: number;
  parentId: number | null;
  parentPath: string | null;
  breadcrumb: Array<{ id: number | null; name: string; path: string }>;
  totalSizeBytes: number;
  entries: TreeEntry[];
}

export interface JobEvent {
  id: number;
  jobId: number;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: string;
  message: string;
  payloadJson: string | null;
}
