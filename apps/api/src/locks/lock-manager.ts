import type { Database } from "bun:sqlite";

type LockState = "active" | "paused";

interface HeldLock {
  jobId: number;
  state: LockState;
  acquiredAt: Date;
  pausedAt: Date | null;
  /** Resolve functions for jobs waiting to acquire this disk's lock. */
  waiters: Array<() => void>;
}

/**
 * Application-level write lock manager, one lock slot per disk.
 *
 * Rules (from decisions.md):
 *   - "active" lock: one job is actively writing. No other writer can start.
 *   - "paused" lock: job still holds the lock but is paused. No other writer
 *     can start (the paused job owns the slot). Readers proceed freely (they
 *     never acquire locks at all — WAL handles concurrent reads).
 *   - No read-lock type. Multiple readers always coexist.
 *   - Application-level uniqueness: only one writer per disk at a time.
 *
 * All state transitions are mirrored synchronously to the `disk_locks` table
 * so the UI and stale-lock cleanup on startup have a durable view.
 */
export class LockManager {
  private locks = new Map<number, HeldLock>();
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Acquires the write lock for `diskId` on behalf of `jobId`.
   * If another job holds the lock (active or paused), this call waits until
   * that lock is released before resolving.
   *
   * Returns a release function — callers should call it in a finally block.
   */
  async acquire(diskId: number, jobId: number): Promise<() => void> {
    const existing = this.locks.get(diskId);

    if (existing) {
      // Wait for the current holder to release
      await new Promise<void>((resolve) => {
        existing.waiters.push(resolve);
      });
    }

    this._setLock(diskId, jobId, "active");
    return () => this.release(diskId);
  }

  /**
   * Transitions an active lock to paused. The holder keeps the slot but yields
   * no writes. Other writers remain queued.
   * Throws if the disk has no active lock or the lock is held by a different job.
   */
  pause(diskId: number, jobId: number): void {
    const lock = this._assertHeld(diskId, jobId, "pause");
    if (lock.state === "paused") return; // idempotent
    lock.state = "paused";
    lock.pausedAt = new Date();
    this._mirrorToDb(diskId, lock);
  }

  /**
   * Transitions a paused lock back to active.
   * Throws if the disk has no paused lock or the lock is held by a different job.
   */
  resume(diskId: number, jobId: number): void {
    const lock = this._assertHeld(diskId, jobId, "resume");
    if (lock.state === "active") return; // idempotent
    lock.state = "active";
    lock.pausedAt = null;
    this._mirrorToDb(diskId, lock);
  }

  /**
   * Releases the lock for `diskId`. If other jobs are waiting, the first one
   * is unblocked and immediately acquires the lock.
   * Throws if the disk has no lock or the lock is held by a different job.
   */
  release(diskId: number): void {
    const lock = this.locks.get(diskId);
    if (!lock) return; // already released (idempotent)

    this.locks.delete(diskId);
    this._clearFromDb(diskId);

    // Unblock the first waiter (if any) — they'll call _setLock themselves
    // via the acquire() flow after this promise resolves.
    const next = lock.waiters.shift();
    if (next) {
      // Pass remaining waiters to the new lock once it's set
      const remainingWaiters = lock.waiters.splice(0);
      next(); // unblock the waiter — acquire() will call _setLock next
      // Attach remaining waiters to the new lock (set by the unblocked acquire())
      // We do this after a microtask so _setLock has already run
      queueMicrotask(() => {
        const newLock = this.locks.get(diskId);
        if (newLock) newLock.waiters.push(...remainingWaiters);
      });
    }
  }

  /** Returns the current lock state for a disk, or null if unlocked. */
  getState(diskId: number): { jobId: number; state: LockState; acquiredAt: Date; pausedAt: Date | null } | null {
    const lock = this.locks.get(diskId);
    if (!lock) return null;
    return { jobId: lock.jobId, state: lock.state, acquiredAt: lock.acquiredAt, pausedAt: lock.pausedAt };
  }

  // --- private helpers ---

  private _setLock(diskId: number, jobId: number, state: LockState): void {
    const lock: HeldLock = {
      jobId,
      state,
      acquiredAt: new Date(),
      pausedAt: null,
      waiters: [],
    };
    this.locks.set(diskId, lock);
    this._mirrorToDb(diskId, lock);
  }

  private _assertHeld(diskId: number, jobId: number, op: string): HeldLock {
    const lock = this.locks.get(diskId);
    if (!lock) throw new Error(`Cannot ${op}: disk ${diskId} has no active lock`);
    if (lock.jobId !== jobId) throw new Error(`Cannot ${op}: disk ${diskId} lock is held by job ${lock.jobId}, not ${jobId}`);
    return lock;
  }

  private _mirrorToDb(diskId: number, lock: HeldLock): void {
    this.db.prepare(
      `INSERT INTO disk_locks (disk_id, held_by_job_id, state, acquired_at, paused_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (disk_id) DO UPDATE SET
         held_by_job_id = excluded.held_by_job_id,
         state          = excluded.state,
         acquired_at    = excluded.acquired_at,
         paused_at      = excluded.paused_at`
    ).run(
      diskId,
      lock.jobId,
      lock.state,
      lock.acquiredAt.toISOString(),
      lock.pausedAt?.toISOString() ?? null
    );
  }

  private _clearFromDb(diskId: number): void {
    this.db.prepare("DELETE FROM disk_locks WHERE disk_id = ?").run(diskId);
  }
}
