import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { makeTestDb, insertDisk } from "../helpers";
import { setDb } from "../../db/client";
import { initJobManager } from "../../jobs";
import { initLockManager } from "../../locks";

import { disksRouter } from "../../routes/disks";
import { jobsRouter } from "../../routes/jobs";
import { treeRouter } from "../../routes/tree";
import { diffRouter } from "../../routes/diff";
import { duplicatesRouter } from "../../routes/duplicates";
import { agentCleanupRouter } from "../../routes/agent-cleanup";
import { excludedPathsRouter } from "../../routes/excluded-paths";
import { copyRouter } from "../../routes/copy";
import { systemRouter } from "../../routes/system";
import { comparisonsRouter } from "../../routes/comparisons";
import { mediaRouter } from "../../routes/media";

export interface TestContext {
  db: Database;
  app: Hono;
}

/**
 * Creates a fresh test app with an in-memory DB and all routes mounted.
 * Call this in beforeEach to isolate tests.
 */
export function createTestApp(): TestContext {
  const db = makeTestDb();

  // Wire up the singletons so route handlers find them
  setDb(db);
  initJobManager(db);
  initLockManager(db);

  const app = new Hono();
  app.route("/api/disks", disksRouter);
  app.route("/api/jobs", jobsRouter);
  app.route("/api/disks/:id/tree", treeRouter);
  app.route("/api/disks/:id/diff", diffRouter);
  app.route("/api/disks/:id/duplicates", duplicatesRouter);
  app.route("/api/disks/:id/cleanup", agentCleanupRouter);
  app.route("/api/disks/:id/excluded-paths", excludedPathsRouter);
  app.route("/api/copy", copyRouter);
  app.route("/api/system", systemRouter);
  app.route("/api/comparisons", comparisonsRouter);
  app.route("/api/media", mediaRouter);

  return { db, app };
}

/** Shorthand for app.request() that returns parsed JSON + status. */
export async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

export { insertDisk };
