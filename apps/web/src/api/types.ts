export interface Disk {
  id: number;
  diskUuid: string;
  label: string | null;
  kind: "ssd" | "hdd";
  role: "source" | "destination";
  capacityBytes: number | null;
  freeBytes: number | null;
  mountPath: string | null;
  isConnected: boolean;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  lastBackupAt: string | null;
  lastVerifyAt: string | null;
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

export interface JobEvent {
  id: number;
  jobId: number;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: string;
  message: string;
  payloadJson: string | null;
}
