import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LockManager } from "../../locks/lock-manager";
import { makeTestDb, insertDisk, insertJob } from "../helpers";

describe("LockManager", () => {
  let db: Database;
  let lm: LockManager;
  let diskId: number;
  let jobId1: number;
  let jobId2: number;

  beforeEach(() => {
    db = makeTestDb();
    lm = new LockManager(db);
    diskId = insertDisk(db);
    jobId1 = insertJob(db);
    jobId2 = insertJob(db);
  });

  describe("acquire", () => {
    it("resolves immediately on an unlocked disk", async () => {
      const release = await lm.acquire(diskId, jobId1);
      expect(typeof release).toBe("function");
      release();
    });

    it("sets state to active after acquire", async () => {
      const release = await lm.acquire(diskId, jobId1);
      const state = lm.getState(diskId);
      expect(state?.state).toBe("active");
      expect(state?.jobId).toBe(jobId1);
      release();
    });

    it("queues a second acquire until the first is released", async () => {
      const release1 = await lm.acquire(diskId, jobId1);

      let job2Done = false;
      const p2 = lm.acquire(diskId, jobId2).then((rel) => {
        job2Done = true;
        return rel;
      });

      // Flush microtasks — job2 should still be waiting
      await Promise.resolve();
      expect(job2Done).toBe(false);

      // Release job1 → job2 should unblock
      release1();
      const release2 = await p2;
      expect(job2Done).toBe(true);

      const state = lm.getState(diskId);
      expect(state?.jobId).toBe(jobId2);
      expect(state?.state).toBe("active");
      release2();
    });

    it("returns a release function that frees the lock", async () => {
      const release = await lm.acquire(diskId, jobId1);
      release();
      expect(lm.getState(diskId)).toBeNull();
    });
  });

  describe("pause / resume", () => {
    it("transitions active → paused", async () => {
      const release = await lm.acquire(diskId, jobId1);
      lm.pause(diskId, jobId1);

      const state = lm.getState(diskId);
      expect(state?.state).toBe("paused");
      expect(state?.pausedAt).toBeInstanceOf(Date);
      release();
    });

    it("is idempotent: pausing an already-paused lock is a no-op", async () => {
      const release = await lm.acquire(diskId, jobId1);
      lm.pause(diskId, jobId1);
      const pausedAt1 = lm.getState(diskId)!.pausedAt;
      lm.pause(diskId, jobId1);
      const pausedAt2 = lm.getState(diskId)!.pausedAt;
      expect(pausedAt1).toEqual(pausedAt2);
      release();
    });

    it("transitions paused → active on resume", async () => {
      const release = await lm.acquire(diskId, jobId1);
      lm.pause(diskId, jobId1);
      lm.resume(diskId, jobId1);

      const state = lm.getState(diskId);
      expect(state?.state).toBe("active");
      expect(state?.pausedAt).toBeNull();
      release();
    });

    it("throws when pausing a disk not held by this job", async () => {
      const release = await lm.acquire(diskId, jobId1);
      expect(() => lm.pause(diskId, jobId2)).toThrow();
      release();
    });

    it("throws when pausing a disk with no lock", () => {
      expect(() => lm.pause(diskId, jobId1)).toThrow();
    });

    it("throws when resuming a disk not held by this job", async () => {
      const release = await lm.acquire(diskId, jobId1);
      lm.pause(diskId, jobId1);
      expect(() => lm.resume(diskId, jobId2)).toThrow();
      release();
    });
  });

  describe("release", () => {
    it("clears state so getState returns null", async () => {
      const release = await lm.acquire(diskId, jobId1);
      release();
      expect(lm.getState(diskId)).toBeNull();
    });

    it("is idempotent: calling release twice does not throw", async () => {
      const release = await lm.acquire(diskId, jobId1);
      release();
      expect(() => release()).not.toThrow();
    });

    it("drains the entire waiter queue in order", async () => {
      const order: number[] = [];
      const jobId3 = insertJob(db);

      const release1 = await lm.acquire(diskId, jobId1);
      const p2 = lm.acquire(diskId, jobId2).then((rel) => { order.push(jobId2); return rel; });
      const p3 = lm.acquire(diskId, jobId3).then((rel) => { order.push(jobId3); return rel; });

      release1();
      const release2 = await p2;
      release2();
      const release3 = await p3;
      release3();

      expect(order).toEqual([jobId2, jobId3]);
    });
  });

  describe("DB mirroring", () => {
    it("inserts a row into disk_locks on acquire", async () => {
      const release = await lm.acquire(diskId, jobId1);
      const row = db.prepare("SELECT * FROM disk_locks WHERE disk_id = ?").get(diskId) as any;
      expect(row).not.toBeNull();
      expect(row.held_by_job_id).toBe(jobId1);
      expect(row.state).toBe("active");
      expect(row.paused_at).toBeNull();
      release();
    });

    it("updates the row to paused state", async () => {
      const release = await lm.acquire(diskId, jobId1);
      lm.pause(diskId, jobId1);
      const row = db.prepare("SELECT * FROM disk_locks WHERE disk_id = ?").get(diskId) as any;
      expect(row.state).toBe("paused");
      expect(row.paused_at).not.toBeNull();
      release();
    });

    it("removes the row on release", async () => {
      const release = await lm.acquire(diskId, jobId1);
      release();
      const row = db.prepare("SELECT * FROM disk_locks WHERE disk_id = ?").get(diskId);
      expect(row).toBeNull();
    });

    it("updates the row to the new holder after a queued acquire resolves", async () => {
      const release1 = await lm.acquire(diskId, jobId1);
      const p2 = lm.acquire(diskId, jobId2);
      release1();
      const release2 = await p2;

      const row = db.prepare("SELECT * FROM disk_locks WHERE disk_id = ?").get(diskId) as any;
      expect(row.held_by_job_id).toBe(jobId2);
      release2();
    });
  });
});
