import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { JobManager } from "../../jobs/job-manager";
import { makeTestDb, insertDisk } from "../helpers";

describe("JobManager", () => {
  let db: Database;
  let jm: JobManager;
  let diskId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    diskId = insertDisk(db);
  });

  describe("createJob", () => {
    it("creates a job with status queued", () => {
      const job = jm.createJob({ type: "scan", targetDiskId: diskId });
      expect(job.status).toBe("queued");
      expect(job.type).toBe("scan");
      expect(job.target_disk_id).toBe(diskId);
      expect(job.id).toBeGreaterThan(0);
    });

    it("defaults created_by to user", () => {
      const job = jm.createJob({ type: "scan" });
      expect(job.created_by).toBe("user");
    });

    it("stores payload as JSON", () => {
      const job = jm.createJob({ type: "copy", payload: { foo: 42 } });
      expect(JSON.parse(job.payload_json!)).toEqual({ foo: 42 });
    });

    it("sets composite created_by when specified", () => {
      const job = jm.createJob({ type: "scan", createdBy: "composite" });
      expect(job.created_by).toBe("composite");
    });
  });

  describe("getJob / listJobs", () => {
    it("returns null for unknown id", () => {
      expect(jm.getJob(9999)).toBeNull();
    });

    it("lists all jobs in reverse creation order", () => {
      jm.createJob({ type: "scan" });
      jm.createJob({ type: "copy" });
      const list = jm.listJobs();
      expect(list[0].type).toBe("copy");
      expect(list[1].type).toBe("scan");
    });

    it("filters by status", () => {
      const j1 = jm.createJob({ type: "scan" });
      jm.transition(j1.id, "running");
      jm.createJob({ type: "copy" }); // stays queued

      const running = jm.listJobs({ status: "running" });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(j1.id);
    });

    it("filters by type", () => {
      jm.createJob({ type: "scan" });
      jm.createJob({ type: "verify" });
      expect(jm.listJobs({ type: "scan" })).toHaveLength(1);
    });
  });

  describe("transition", () => {
    it("queued → running sets started_at", () => {
      const job = jm.createJob({ type: "scan" });
      const updated = jm.transition(job.id, "running");
      expect(updated.status).toBe("running");
      expect(updated.started_at).not.toBeNull();
    });

    it("running → paused", () => {
      const job = jm.createJob({ type: "scan" });
      jm.transition(job.id, "running");
      const paused = jm.transition(job.id, "paused");
      expect(paused.status).toBe("paused");
    });

    it("paused → running", () => {
      const job = jm.createJob({ type: "scan" });
      jm.transition(job.id, "running");
      jm.transition(job.id, "paused");
      const resumed = jm.transition(job.id, "running");
      expect(resumed.status).toBe("running");
    });

    it("running → completed sets completed_at", () => {
      const job = jm.createJob({ type: "scan" });
      jm.transition(job.id, "running");
      const done = jm.transition(job.id, "completed");
      expect(done.status).toBe("completed");
      expect(done.completed_at).not.toBeNull();
    });

    it("running → failed sets completed_at", () => {
      const job = jm.createJob({ type: "scan" });
      jm.transition(job.id, "running");
      const failed = jm.transition(job.id, "failed");
      expect(failed.status).toBe("failed");
      expect(failed.completed_at).not.toBeNull();
    });

    it("throws on invalid transition (queued → completed)", () => {
      const job = jm.createJob({ type: "scan" });
      expect(() => jm.transition(job.id, "completed")).toThrow(/Invalid transition/);
    });

    it("throws on invalid transition (completed → running)", () => {
      const job = jm.createJob({ type: "scan" });
      jm.transition(job.id, "running");
      jm.transition(job.id, "completed");
      expect(() => jm.transition(job.id, "running")).toThrow(/Invalid transition/);
    });

    it("throws for unknown job", () => {
      expect(() => jm.transition(9999, "running")).toThrow(/not found/);
    });
  });

  describe("incrementProgress", () => {
    it("adds to aggregate counters", () => {
      const job = jm.createJob({ type: "scan" });
      jm.incrementProgress(job.id, { bytesProcessed: 1024, itemsProcessed: 3 });
      jm.incrementProgress(job.id, { bytesProcessed: 512, itemsProcessed: 1, errorsCount: 1 });

      const updated = jm.getJob(job.id)!;
      expect(updated.bytes_processed).toBe(1536);
      expect(updated.items_processed).toBe(4);
      expect(updated.errors_count).toBe(1);
    });

    it("updates progress_json when provided", () => {
      const job = jm.createJob({ type: "scan" });
      jm.incrementProgress(job.id, { progressJson: { filesPerSec: 42 } });
      const updated = jm.getJob(job.id)!;
      expect(JSON.parse(updated.progress_json!)).toEqual({ filesPerSec: 42 });
    });
  });

  describe("logEvent / getEvents", () => {
    it("inserts an event and retrieves it", () => {
      const job = jm.createJob({ type: "scan" });
      jm.logEvent(job.id, "info", "phase_change", "Scanning started");
      const events = jm.getEvents(job.id);
      expect(events).toHaveLength(1);
      expect(events[0].level).toBe("info");
      expect(events[0].category).toBe("phase_change");
      expect(events[0].message).toBe("Scanning started");
    });

    it("stores structured payload as JSON", () => {
      const job = jm.createJob({ type: "scan" });
      jm.logEvent(job.id, "warning", "excluded", "node_modules excluded", { path: "/foo/node_modules" });
      const events = jm.getEvents(job.id);
      expect(JSON.parse(events[0].payload_json!)).toEqual({ path: "/foo/node_modules" });
    });

    it("returns events in chronological order", () => {
      const job = jm.createJob({ type: "scan" });
      jm.logEvent(job.id, "info", "a", "first");
      jm.logEvent(job.id, "info", "b", "second");
      const events = jm.getEvents(job.id);
      expect(events[0].message).toBe("first");
      expect(events[1].message).toBe("second");
    });
  });
});
