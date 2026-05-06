import type { JobManager } from "./job-manager";
import { sseRegistry } from "./sse";

const FLUSH_INTERVAL_MS = 250;

interface PendingProgress {
  bytesProcessed: number;
  itemsProcessed: number;
  warningsCount: number;
  nonCriticalErrorsCount: number;
  errorsCount: number;
  progressJson: unknown | undefined;
}

/**
 * Abstract base class for all job types (scan, copy, verify, backup).
 *
 * Concrete subclasses implement `execute()`, which should call:
 *   - `await this.checkPause()` at safe checkpoints (e.g. between items)
 *   - `this.incrementProgress(delta)` as work is done
 *   - `this.logEvent(...)` for notable events
 *
 * The base class handles:
 *   - Status transitions (queued → running → paused/completed/failed/cancelled)
 *   - Batched progress flushing to DB + SSE every 250ms
 *   - Pause/resume via an async checkpoint mechanism
 *   - Cancellation via an AbortSignal
 */
export abstract class JobRunner {
  readonly jobId: number;

  protected readonly jobManager: JobManager;
  protected readonly abortController = new AbortController();

  private _isPaused = false;
  private _resumeResolve: (() => void) | null = null;

  private _pending: PendingProgress = this._zeroPending();
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(jobId: number, jobManager: JobManager) {
    this.jobId = jobId;
    this.jobManager = jobManager;
  }

  // ---------------------------------------------------------------------------
  // Public control interface (called by routes / composite jobs)
  // ---------------------------------------------------------------------------

  /**
   * Starts the job. Transitions queued → running, kicks off execute(),
   * and resolves when the job reaches a terminal state.
   *
   * The returned Promise always resolves (never rejects) — errors are recorded
   * in the DB and surfaced via the `failed` status.
   */
  async start(): Promise<void> {
    this.jobManager.transition(this.jobId, "running");
    this._startFlushTimer();
    this._broadcastStatus();

    try {
      await this.execute();
      if (!this.abortController.signal.aborted) {
        this._flush();
        this.jobManager.transition(this.jobId, "completed");
        this._broadcastStatus();
      }
    } catch (err) {
      this._flush();
      this.jobManager.logEvent(
        this.jobId,
        "error",
        "error",
        err instanceof Error ? err.message : String(err)
      );
      // Only fail if not already cancelled
      const current = this.jobManager.getJob(this.jobId);
      if (current && current.status !== "cancelled") {
        this.jobManager.transition(this.jobId, "failed");
        this._broadcastStatus();
      }
    } finally {
      this._stopFlushTimer();
    }
  }

  /**
   * Signals the job to pause at its next `checkPause()` call.
   * The DB transition (running → paused) happens when the job actually suspends.
   */
  pause(): void {
    if (this._isPaused) return;
    this._isPaused = true;
  }

  /**
   * Resumes a paused job.
   */
  resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;
    this._resumeResolve?.();
    this._resumeResolve = null;
  }

  /**
   * Cancels the job. Works from any non-terminal state.
   */
  cancel(): void {
    this.abortController.abort();
    this._isPaused = false;
    this._resumeResolve?.();
    this._resumeResolve = null;

    const current = this.jobManager.getJob(this.jobId);
    if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
      this._flush();
      this.jobManager.transition(this.jobId, "cancelled");
      this._broadcastStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Protected API for subclasses
  // ---------------------------------------------------------------------------

  /** The subclass's main work loop. Should be interruptible via checkPause(). */
  protected abstract execute(): Promise<void>;

  /**
   * Call at safe checkpoints in the work loop. Suspends execution if paused,
   * throws if cancelled.
   */
  protected async checkPause(): Promise<void> {
    if (this.abortController.signal.aborted) {
      throw new Error("Job cancelled");
    }
    if (!this._isPaused) return;

    // Flush what we have so far before suspending
    this._flush();
    this.jobManager.transition(this.jobId, "paused");
    this._broadcastStatus();

    await new Promise<void>((resolve) => {
      this._resumeResolve = resolve;
    });

    if (this.abortController.signal.aborted) {
      throw new Error("Job cancelled");
    }

    this.jobManager.transition(this.jobId, "running");
    this._broadcastStatus();
  }

  /**
   * Accumulates progress increments. Flushed to DB + SSE every 250ms by the timer.
   */
  protected incrementProgress(delta: Partial<PendingProgress>): void {
    this._pending.bytesProcessed           += delta.bytesProcessed           ?? 0;
    this._pending.itemsProcessed           += delta.itemsProcessed           ?? 0;
    this._pending.warningsCount            += delta.warningsCount            ?? 0;
    this._pending.nonCriticalErrorsCount   += delta.nonCriticalErrorsCount   ?? 0;
    this._pending.errorsCount              += delta.errorsCount              ?? 0;
    if (delta.progressJson !== undefined) {
      this._pending.progressJson = delta.progressJson;
    }
  }

  protected logEvent(
    level: "info" | "warning" | "error",
    category: string,
    message: string,
    payload?: unknown
  ): void {
    this.jobManager.logEvent(this.jobId, level, category, message, payload);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _zeroPending(): PendingProgress {
    return {
      bytesProcessed: 0,
      itemsProcessed: 0,
      warningsCount: 0,
      nonCriticalErrorsCount: 0,
      errorsCount: 0,
      progressJson: undefined,
    };
  }

  private _flush(): void {
    const p = this._pending;
    const hasWork =
      p.bytesProcessed > 0 ||
      p.itemsProcessed > 0 ||
      p.warningsCount > 0 ||
      p.nonCriticalErrorsCount > 0 ||
      p.errorsCount > 0 ||
      p.progressJson !== undefined;

    if (!hasWork) return;

    this.jobManager.incrementProgress(this.jobId, p);
    this._pending = this._zeroPending();

    // Broadcast current job state over SSE
    const job = this.jobManager.getJob(this.jobId);
    if (job) sseRegistry.publish(this.jobId, "progress", formatJobForSse(job));
  }

  private _broadcastStatus(): void {
    const job = this.jobManager.getJob(this.jobId);
    if (job) sseRegistry.publish(this.jobId, "status", formatJobForSse(job));
  }

  private _startFlushTimer(): void {
    this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
  }

  private _stopFlushTimer(): void {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }
}

function formatJobForSse(job: ReturnType<JobManager["getJob"]>) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    bytesProcessed: job.bytes_processed,
    itemsProcessed: job.items_processed,
    warningsCount: job.warnings_count,
    nonCriticalErrorsCount: job.non_critical_errors_count,
    errorsCount: job.errors_count,
    progressJson: job.progress_json ? JSON.parse(job.progress_json) : null,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}
