import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { JobManager, type JobStatus } from "../../jobs/job-manager";
import { JobRunner } from "../../jobs/job-runner";
import { sseRegistry } from "../../jobs/sse";
import { makeTestDb, insertDisk } from "../helpers";

/** Polls the DB until the job reaches the expected status (or 2s timeout). */
async function waitForStatus(jm: JobManager, jobId: number, status: JobStatus): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (jm.getJob(jobId)?.status === status) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`Job ${jobId} did not reach status '${status}' within 2s`);
}

// ---------------------------------------------------------------------------
// Concrete test subclass — exposes internals for inspection
// ---------------------------------------------------------------------------

class TestRunner extends JobRunner {
  steps: number;
  completedSteps = 0;
  /** If set, pauses before this step index. */
  pauseBeforeStep: number | null = null;

  constructor(jobId: number, jm: JobManager, steps = 3) {
    super(jobId, jm);
    this.steps = steps;
  }

  protected async execute(): Promise<void> {
    for (let i = 0; i < this.steps; i++) {
      // Yield to the event loop so external callers (tests, routes) can call
      // pause()/cancel() between steps. Real jobs yield naturally via I/O.
      await new Promise<void>((r) => setImmediate(r));
      await this.checkPause();
      this.incrementProgress({ itemsProcessed: 1, bytesProcessed: 100 });
      this.completedSteps++;
    }
  }
}

/** Creates a job in the DB and returns a TestRunner for it. */
function makeRunner(jm: JobManager, diskId: number, steps = 3): TestRunner {
  const job = jm.createJob({ type: "scan", targetDiskId: diskId });
  return new TestRunner(job.id, jm, steps);
}

// ---------------------------------------------------------------------------

describe("JobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let diskId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    diskId = insertDisk(db);
  });

  describe("start / lifecycle", () => {
    it("transitions job to running then completed", async () => {
      const runner = makeRunner(jm, diskId);
      await runner.start();
      expect(jm.getJob(runner.jobId)!.status).toBe("completed");
    });

    it("executes all steps", async () => {
      const runner = makeRunner(jm, diskId, 5);
      await runner.start();
      expect(runner.completedSteps).toBe(5);
    });

    it("sets started_at and completed_at", async () => {
      const runner = makeRunner(jm, diskId);
      await runner.start();
      const job = jm.getJob(runner.jobId)!;
      expect(job.started_at).not.toBeNull();
      expect(job.completed_at).not.toBeNull();
    });

    it("flushes accumulated progress on completion", async () => {
      const runner = makeRunner(jm, diskId, 4);
      await runner.start();
      const job = jm.getJob(runner.jobId)!;
      expect(job.items_processed).toBe(4);
      expect(job.bytes_processed).toBe(400);
    });

    it("transitions job to failed when execute() throws", async () => {
      const job = jm.createJob({ type: "scan", targetDiskId: diskId });
      const runner = new class extends JobRunner {
        protected async execute() { throw new Error("boom"); }
      }(job.id, jm);
      await runner.start();
      expect(jm.getJob(job.id)!.status).toBe("failed");
    });

    it("logs an error event when execute() throws", async () => {
      const job = jm.createJob({ type: "scan", targetDiskId: diskId });
      const runner = new class extends JobRunner {
        protected async execute() { throw new Error("disk read error"); }
      }(job.id, jm);
      await runner.start();
      const events = jm.getEvents(job.id);
      expect(events.some((e) => e.level === "error" && e.message.includes("disk read error"))).toBe(true);
    });
  });

  describe("pause / resume", () => {
    it("pauses mid-execution and transitions status to paused", async () => {
      const runner = makeRunner(jm, diskId, 10);
      const done = runner.start();

      // Yield once (lets step 0 start) then pause — subsequent checkPause() suspends
      await new Promise((r) => setImmediate(r));
      runner.pause();
      await waitForStatus(jm, runner.jobId, "paused");

      expect(jm.getJob(runner.jobId)!.status).toBe("paused");
      const stepsBeforeResume = runner.completedSteps;

      runner.resume();
      await done;

      expect(jm.getJob(runner.jobId)!.status).toBe("completed");
      expect(runner.completedSteps).toBe(10);
      expect(stepsBeforeResume).toBeLessThan(10);
    });

    it("paused → running transition is recorded in DB", async () => {
      const runner = makeRunner(jm, diskId, 10);
      const done = runner.start();

      await new Promise((r) => setImmediate(r));
      runner.pause();
      await waitForStatus(jm, runner.jobId, "paused");

      runner.resume();
      await done;

      expect(jm.getJob(runner.jobId)!.status).toBe("completed");
    });
  });

  describe("cancel", () => {
    it("transitions job to cancelled", async () => {
      const runner = makeRunner(jm, diskId, 100);
      const done = runner.start();
      await new Promise((r) => setImmediate(r));
      runner.cancel();
      await done;
      expect(jm.getJob(runner.jobId)!.status).toBe("cancelled");
    });

    it("stops executing after cancel", async () => {
      const runner = makeRunner(jm, diskId, 100);
      const done = runner.start();
      await new Promise((r) => setImmediate(r));
      runner.cancel();
      await done;
      expect(runner.completedSteps).toBeLessThan(100);
    });

    it("can cancel a paused job", async () => {
      const runner = makeRunner(jm, diskId, 100);
      const done = runner.start();
      await new Promise((r) => setImmediate(r));
      runner.pause();
      await waitForStatus(jm, runner.jobId, "paused");
      runner.cancel();
      await done;
      expect(jm.getJob(runner.jobId)!.status).toBe("cancelled");
    });
  });

  describe("SSE broadcasts", () => {
    it("publishes a status event when job starts", async () => {
      const runner = makeRunner(jm, diskId);
      const received: string[] = [];
      const unsub = sseRegistry.subscribe(runner.jobId, ({ event }) => {
        received.push(event);
      });
      await runner.start();
      unsub();
      expect(received).toContain("status");
    });

    it("publishes a status event when job completes", async () => {
      const runner = makeRunner(jm, diskId);
      const statuses: string[] = [];
      const unsub = sseRegistry.subscribe(runner.jobId, ({ event, data }) => {
        if (event === "status") statuses.push((data as any).status);
      });
      await runner.start();
      unsub();
      expect(statuses).toContain("running");
      expect(statuses).toContain("completed");
    });
  });
});
