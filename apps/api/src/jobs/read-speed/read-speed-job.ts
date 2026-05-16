import type { Database } from "bun:sqlite";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";

interface FileTarget {
  path: string;
  sizeBytes: number;
}

interface FileResult {
  path: string;
  sizeBytes: number;
  sampledHashMs: number;
  sampledHashMBps: number;
  fullHashMs: number;
  fullHashMBps: number;
}

interface ReadSpeedProgress {
  filesCompleted: number;
  filesTotal: number;
  results: FileResult[];
  summary?: {
    avgSampledMBps: number;
    avgFullMBps: number;
    totalBytes: number;
    totalMs: number;
  };
}

export class ReadSpeedJobRunner extends JobRunner {
  private diskId: number;
  private db: Database;
  private sampleCount: number;
  private worker: Worker | null = null;
  private progress: ReadSpeedProgress;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
    sampleCount: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.diskId = opts.diskId;
    this.db = opts.db;
    this.sampleCount = opts.sampleCount;
    this.progress = {
      filesCompleted: 0,
      filesTotal: 0,
      results: [],
    };
  }

  override pause(): void {
    this.worker?.postMessage({ type: "pause" });
    super.pause();
  }

  override resume(): void {
    super.resume();
    this.worker?.postMessage({ type: "resume" });
  }

  override cancel(): void {
    this.worker?.postMessage({ type: "cancel" });
    super.cancel();
  }

  protected async execute(): Promise<void> {
    trace("read_speed_start", {
      job_id: this.jobId,
      disk_id: this.diskId,
      sample_count: this.sampleCount,
    });

    const files = this.findLargestFiles();
    if (files.length === 0) {
      this.logEvent("warning", "no_files", "No scanned files found on this disk to benchmark");
      return;
    }

    this.progress.filesTotal = files.length;
    this.broadcastProgress();

    this.logEvent(
      "info",
      "progress_milestone",
      `Read speed test: benchmarking ${files.length} files (${formatBytes(files.reduce((s, f) => s + f.sizeBytes, 0))} total)`
    );

    await this.runWorker(files);
  }

  private runWorker(files: FileTarget[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.worker = new Worker(
        new URL("./read-speed-worker.ts", import.meta.url).href
      );

      let totalSampledMs = 0;
      let totalFullMs = 0;
      let totalBytes = 0;

      this.worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        switch (msg.type) {
          case "file_done": {
            const result: FileResult = msg.result;

            this.progress.results.push(result);
            this.progress.filesCompleted += 1;
            totalSampledMs += result.sampledHashMs;
            totalFullMs += result.fullHashMs;
            totalBytes += result.sizeBytes;

            this.incrementProgress({
              bytesProcessed: result.sizeBytes,
              itemsProcessed: 1,
              progressJson: this.progress,
            });

            this.logEvent(
              "info",
              "file_benchmarked",
              `${result.path}: sampled ${result.sampledHashMBps} MB/s (${result.sampledHashMs}ms), full ${result.fullHashMBps} MB/s (${result.fullHashMs}ms)`,
              result
            );
            break;
          }

          case "done": {
            const mbps = (bytes: number, ms: number) =>
              ms > 0 ? (bytes / (1024 * 1024)) / (ms / 1000) : 0;

            this.progress.summary = {
              avgSampledMBps: Math.round(mbps(totalBytes, totalSampledMs) * 10) / 10,
              avgFullMBps: Math.round(mbps(totalBytes, totalFullMs) * 10) / 10,
              totalBytes,
              totalMs: Math.round(totalSampledMs + totalFullMs),
            };

            this.broadcastProgress();

            this.logEvent(
              "info",
              "progress_milestone",
              `Read speed test complete: sampled avg ${this.progress.summary.avgSampledMBps} MB/s, full avg ${this.progress.summary.avgFullMBps} MB/s over ${formatBytes(totalBytes)}`
            );

            trace("read_speed_end", {
              job_id: this.jobId,
              files_benchmarked: files.length,
              total_bytes: totalBytes,
              avg_sampled_mbps: this.progress.summary.avgSampledMBps,
              avg_full_mbps: this.progress.summary.avgFullMBps,
            });

            this.worker?.terminate();
            this.worker = null;
            resolve();
            break;
          }

          case "error":
            this.worker?.terminate();
            this.worker = null;
            reject(new Error(msg.message));
            break;
        }
      };

      this.worker.onerror = (event) => {
        this.worker?.terminate();
        this.worker = null;
        reject(new Error(`Worker error: ${event.message}`));
      };

      this.worker.postMessage({ type: "start", files });
    });
  }

  /**
   * Finds the N largest files from the latest completed scan for this disk.
   */
  private findLargestFiles(): FileTarget[] {
    const latestScan = this.db
      .prepare(
        `SELECT id FROM jobs
         WHERE type = 'scan' AND target_disk_id = ? AND status = 'completed'
         ORDER BY completed_at DESC LIMIT 1`
      )
      .get(this.diskId) as { id: number } | null;

    if (!latestScan) return [];

    const rows = this.db
      .prepare(
        `SELECT path, size_bytes FROM files
         WHERE scan_id = ? AND size_bytes > 0
         ORDER BY size_bytes DESC
         LIMIT ?`
      )
      .all(latestScan.id, this.sampleCount) as Array<{ path: string; size_bytes: number }>;

    return rows.map((r) => ({ path: r.path, sizeBytes: r.size_bytes }));
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
