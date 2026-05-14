import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { LockManager } from "../../locks/lock-manager";
import { getLockManager } from "../../locks";
import { getDiskStats } from "../../fs/disk-io";
import { writeGeneratedTestFileAtomic } from "../../fs/disk-writes";
import { trace } from "../../diag/trace";

const PREFLIGHT_MARGIN = 256 * 1024 * 1024;

interface WriteSpeedProgress {
  filePath: string;
  mode: "null" | "random";
  totalBytes: number;
  bytesWritten: number;
  diskFreeBytes: number | null;
}

export class WriteSpeedJobRunner extends JobRunner {
  private diskId: number;
  private mountPath: string;
  private totalBytes: number;
  private mode: "null" | "random";
  private fileUuid: string;
  private lockManager: LockManager;
  private releaseLock: (() => void) | null = null;

  private progress: WriteSpeedProgress;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    diskId: number;
    mountPath: string;
    totalBytes: number;
    mode: "null" | "random";
    fileUuid: string;
  }) {
    super(opts.jobId, opts.jobManager);
    this.diskId = opts.diskId;
    this.mountPath = opts.mountPath;
    this.totalBytes = opts.totalBytes;
    this.mode = opts.mode;
    this.fileUuid = opts.fileUuid;
    this.lockManager = getLockManager();
    this.progress = {
      filePath: `.waypoint-test-copy-${opts.fileUuid}`,
      mode: opts.mode,
      totalBytes: opts.totalBytes,
      bytesWritten: 0,
      diskFreeBytes: null,
    };
  }

  override pause(): void {
    if (this.releaseLock) {
      this.lockManager.pause(this.diskId, this.jobId);
    }
    super.pause();
  }

  override resume(): void {
    super.resume();
    if (this.releaseLock) {
      this.lockManager.resume(this.diskId, this.jobId);
    }
  }

  override cancel(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
    super.cancel();
  }

  protected async execute(): Promise<void> {
    trace("write_speed_start", {
      job_id: this.jobId,
      disk_id: this.diskId,
      total_bytes: this.totalBytes,
      mode: this.mode,
    });

    this.preflightDiskCheck();
    this.broadcastProgress();

    this.releaseLock = await this.lockManager.acquire(this.diskId, this.jobId);
    try {
      await writeGeneratedTestFileAtomic({
        destMountPath: this.mountPath,
        fileUuid: this.fileUuid,
        totalBytes: this.totalBytes,
        mode: this.mode,
        tempSuffix: crypto.randomUUID(),
        onChunkWritten: async (bytes) => {
          this.progress.bytesWritten += bytes;
          this.incrementProgress({
            bytesProcessed: bytes,
            progressJson: this.progress,
          });
          await this.checkPause();
        },
      });
    } finally {
      if (this.releaseLock) {
        this.releaseLock();
        this.releaseLock = null;
      }
    }

    this.progress.bytesWritten = this.totalBytes;
    this.broadcastProgress();
    this.logEvent(
      "info",
      "progress_milestone",
      `Write speed test complete: wrote ${formatBytes(this.totalBytes)} to ${this.progress.filePath}`,
      { filePath: this.progress.filePath, mode: this.mode }
    );

    trace("write_speed_end", {
      job_id: this.jobId,
      bytes_written: this.totalBytes,
      file_path: this.progress.filePath,
    });
  }

  private preflightDiskCheck(): void {
    const stats = getDiskStats(this.mountPath);
    this.progress.diskFreeBytes = stats.freeBytes;

    if (stats.freeBytes !== null) {
      const needed = this.totalBytes + PREFLIGHT_MARGIN;
      if (stats.freeBytes < needed) {
        const msg = `Insufficient disk space: need ${formatBytes(needed)}, have ${formatBytes(stats.freeBytes)}`;
        this.logEvent("error", "disk_space", msg);
        throw new Error(msg);
      }
    }
  }

  private broadcastProgress(): void {
    this.incrementProgress({ progressJson: this.progress });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
