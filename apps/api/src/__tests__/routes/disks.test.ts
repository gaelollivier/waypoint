import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";

describe("disks routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ── GET /api/disks ──────────────────────────────────────────────

  describe("GET /api/disks", () => {
    it("returns empty array when no disks registered", async () => {
      const res = await req(ctx.app, "GET", "/api/disks");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns all registered disks", async () => {
      insertDisk(ctx.db, { label: "Disk A", kind: "ssd" });
      insertDisk(ctx.db, { label: "Disk B", kind: "hdd" });

      const res = await req(ctx.app, "GET", "/api/disks");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].label).toBe("Disk A");
      expect(res.body[0].kind).toBe("ssd");
      expect(res.body[1].label).toBe("Disk B");
    });

    it("formats disk fields correctly", async () => {
      insertDisk(ctx.db, { label: "My Disk", kind: "hdd", is_connected: 1, mount_path: "/mnt/x" });

      const res = await req(ctx.app, "GET", "/api/disks");
      const disk = res.body[0];
      expect(disk).toHaveProperty("id");
      expect(disk).toHaveProperty("diskUuid");
      expect(disk).toHaveProperty("label", "My Disk");
      expect(disk).toHaveProperty("kind", "hdd");
      expect(disk).toHaveProperty("mountPath", "/mnt/x");
      expect(disk).toHaveProperty("isConnected", true);
      expect(disk).toHaveProperty("capacityBytes");
      expect(disk).toHaveProperty("freeBytes");
      expect(disk).toHaveProperty("lastSeenAt");
      expect(disk).toHaveProperty("lastScanAt");
      expect(disk).toHaveProperty("lastBackupAt");
      expect(disk).toHaveProperty("lastVerifyAt");
    });
  });

  // ── GET /api/disks/:id ──────────────────────────────────────────

  describe("GET /api/disks/:id", () => {
    it("returns a single disk by id", async () => {
      const id = insertDisk(ctx.db, { label: "Solo", kind: "ssd" });

      const res = await req(ctx.app, "GET", `/api/disks/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.label).toBe("Solo");
    });

    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "GET", "/api/disks/9999");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });
  });

  // ── PATCH /api/disks/:id ────────────────────────────────────────

  describe("PATCH /api/disks/:id", () => {
    it("updates the label", async () => {
      const id = insertDisk(ctx.db, { label: "Old Label" });

      const res = await req(ctx.app, "PATCH", `/api/disks/${id}`, { label: "New Label" });
      expect(res.status).toBe(200);
      expect(res.body.label).toBe("New Label");
    });

    it("updates the kind", async () => {
      const id = insertDisk(ctx.db, { kind: "hdd" });

      const res = await req(ctx.app, "PATCH", `/api/disks/${id}`, { kind: "ssd" });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("ssd");
    });

    it("updates both label and kind at once", async () => {
      const id = insertDisk(ctx.db, { label: "Old", kind: "hdd" });

      const res = await req(ctx.app, "PATCH", `/api/disks/${id}`, {
        label: "Updated",
        kind: "ssd",
      });
      expect(res.status).toBe(200);
      expect(res.body.label).toBe("Updated");
      expect(res.body.kind).toBe("ssd");
    });

    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "PATCH", "/api/disks/9999", { label: "Ghost" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });

    it("returns 400 for invalid kind", async () => {
      const id = insertDisk(ctx.db);

      const res = await req(ctx.app, "PATCH", `/api/disks/${id}`, { kind: "floppy" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("kind must be ssd or hdd");
    });

    it("returns 400 for invalid disk id", async () => {
      const res = await req(ctx.app, "PATCH", "/api/disks/abc", { label: "X" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid disk id");
    });
  });

  // ── POST /api/disks/:id/scan ────────────────────────────────────

  describe("POST /api/disks/:id/scan", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `waypoint-test-scan-${crypto.randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns 202 with a jobId for a connected disk", async () => {
      const id = insertDisk(ctx.db, { mount_path: tempDir, is_connected: 1 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/scan`);
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(typeof res.body.jobId).toBe("number");
    });

    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "POST", "/api/disks/9999/scan");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });

    it("returns 409 for a disconnected disk", async () => {
      const id = insertDisk(ctx.db, { is_connected: 0 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/scan`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Disk is not connected");
    });

    it("returns 409 when a scan is already active", async () => {
      const id = insertDisk(ctx.db, { mount_path: tempDir, is_connected: 1 });

      // Start a first scan
      const first = await req(ctx.app, "POST", `/api/disks/${id}/scan`);
      expect(first.status).toBe(202);

      // Attempt a second scan while the first is active
      const second = await req(ctx.app, "POST", `/api/disks/${id}/scan`);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("A scan is already active for this disk");
    });
  });

  // ── POST /api/disks/:id/write-speed-test ────────────────────────

  describe("POST /api/disks/:id/write-speed-test", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `waypoint-test-write-${crypto.randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns 202 with a jobId for a connected disk", async () => {
      const id = insertDisk(ctx.db, { mount_path: tempDir, is_connected: 1 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/write-speed-test`);
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(res.body).toHaveProperty("filePath");
      expect(res.body.filePath).toMatch(/^\.waypoint-test-copy-/);
    });

    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "POST", "/api/disks/9999/write-speed-test");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });

    it("returns 409 for a disconnected disk", async () => {
      const id = insertDisk(ctx.db, { is_connected: 0 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/write-speed-test`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Disk is not connected");
    });

    it("returns 400 for invalid sizeBytes", async () => {
      const id = insertDisk(ctx.db, { mount_path: tempDir, is_connected: 1 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/write-speed-test`, {
        sizeBytes: -100,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("sizeBytes must be a positive safe integer");
    });

    it("returns 400 for invalid mode", async () => {
      const id = insertDisk(ctx.db, { mount_path: tempDir, is_connected: 1 });

      const res = await req(ctx.app, "POST", `/api/disks/${id}/write-speed-test`, {
        mode: "sequential",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("mode must be null or random");
    });
  });

  // ── GET /api/disks/:id/events ───────────────────────────────────

  describe("GET /api/disks/:id/events", () => {
    it("returns events for an existing disk", async () => {
      const id = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${id}/events`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "GET", "/api/disks/9999/events");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });
  });

  // ── GET /api/disks/:id/lock ─────────────────────────────────────

  describe("GET /api/disks/:id/lock", () => {
    it("returns unlocked state when no lock is held", async () => {
      const id = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${id}/lock`);
      expect(res.status).toBe(200);
      expect(res.body.diskId).toBe(id);
      expect(res.body.locked).toBe(false);
    });

    it("returns unlocked state even for a non-existent disk id", async () => {
      // The lock endpoint does not check disk existence — it just reports lock state
      const res = await req(ctx.app, "GET", "/api/disks/9999/lock");
      expect(res.status).toBe(200);
      expect(res.body.locked).toBe(false);
    });
  });
});
