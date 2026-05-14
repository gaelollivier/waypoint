import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

describe("GET /api/jobs", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns an empty list when no jobs exist", async () => {
    const res = await req(ctx.app, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns all jobs after inserting some", async () => {
    const id1 = insertJob(ctx.db, { type: "scan", status: "running" });
    const id2 = insertJob(ctx.db, { type: "copy", status: "completed" });
    const res = await req(ctx.app, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const ids = res.body.map((j: any) => j.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("filters by status", async () => {
    insertJob(ctx.db, { status: "running" });
    insertJob(ctx.db, { status: "completed" });
    insertJob(ctx.db, { status: "completed" });
    const res = await req(ctx.app, "GET", "/api/jobs?status=completed");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const job of res.body) {
      expect(job.status).toBe("completed");
    }
  });

  it("filters by type", async () => {
    insertJob(ctx.db, { type: "scan" });
    insertJob(ctx.db, { type: "copy" });
    const res = await req(ctx.app, "GET", "/api/jobs?type=scan");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe("scan");
  });

  it("filters by targetDiskId", async () => {
    const { insertDisk } = await import("./helpers");
    const diskId = insertDisk(ctx.db);
    insertJob(ctx.db, { target_disk_id: diskId });
    insertJob(ctx.db, { target_disk_id: null });
    const res = await req(ctx.app, "GET", `/api/jobs?targetDiskId=${diskId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].targetDiskId).toBe(diskId);
  });

  it("respects limit parameter", async () => {
    insertJob(ctx.db);
    insertJob(ctx.db);
    insertJob(ctx.db);
    const res = await req(ctx.app, "GET", "/api/jobs?limit=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("GET /api/jobs/:id", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns 200 with the job for an existing id", async () => {
    const id = insertJob(ctx.db, { type: "scan", status: "running" });
    const res = await req(ctx.app, "GET", `/api/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.type).toBe("scan");
    expect(res.body.status).toBe("running");
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await req(ctx.app, "GET", "/api/jobs/99999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe("GET /api/jobs/:id/events-log", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns 200 with an empty events list for an existing job", async () => {
    const id = insertJob(ctx.db);
    const res = await req(ctx.app, "GET", `/api/jobs/${id}/events-log`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await req(ctx.app, "GET", "/api/jobs/99999/events-log");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /api/jobs/:id/pause", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await req(ctx.app, "POST", "/api/jobs/99999/pause");
    expect(res.status).toBe(404);
  });

  it("returns 409 for a non-running job", async () => {
    const id = insertJob(ctx.db, { status: "completed" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/pause`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("completed");
  });

  it("transitions an orphaned running job to paused via DB", async () => {
    const id = insertJob(ctx.db, { status: "running" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify the job is now paused in DB
    const check = await req(ctx.app, "GET", `/api/jobs/${id}`);
    expect(check.body.status).toBe("paused");
  });
});

describe("POST /api/jobs/:id/resume", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await req(ctx.app, "POST", "/api/jobs/99999/resume");
    expect(res.status).toBe(404);
  });

  it("returns 409 for a non-paused job", async () => {
    const id = insertJob(ctx.db, { status: "running" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("running");
  });
});

describe("POST /api/jobs/:id/cancel", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestApp();
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await req(ctx.app, "POST", "/api/jobs/99999/cancel");
    expect(res.status).toBe(404);
  });

  it("returns 409 for an already-completed job", async () => {
    const id = insertJob(ctx.db, { status: "completed" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("completed");
  });

  it("returns 409 for an already-failed job", async () => {
    const id = insertJob(ctx.db, { status: "failed" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("failed");
  });

  it("returns 409 for an already-cancelled job", async () => {
    const id = insertJob(ctx.db, { status: "cancelled" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("cancelled");
  });

  it("cancels a queued job via DB transition", async () => {
    const id = insertJob(ctx.db, { status: "queued" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify the job is now cancelled
    const check = await req(ctx.app, "GET", `/api/jobs/${id}`);
    expect(check.body.status).toBe("cancelled");
  });

  it("cancels an orphaned running job via DB transition", async () => {
    const id = insertJob(ctx.db, { status: "running" });
    const res = await req(ctx.app, "POST", `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await req(ctx.app, "GET", `/api/jobs/${id}`);
    expect(check.body.status).toBe("cancelled");
  });
});
