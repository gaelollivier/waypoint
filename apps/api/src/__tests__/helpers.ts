import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";

/**
 * Returns a fresh in-memory SQLite database with all migrations applied.
 * Use one per test (or per describe block) to keep tests isolated.
 */
export function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Inserts a minimal disk row (only required fields) and returns its id.
 */
export function insertDisk(
  db: Database,
  overrides: Partial<{
    disk_uuid: string;
    kind: "ssd" | "hdd";
    label: string;
    mount_path: string;
    is_connected: number;
  }> = {}
): number {
  const opts = {
    disk_uuid: crypto.randomUUID(),
    kind: "hdd" as const,
    label: null,
    mount_path: null,
    is_connected: 0,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO disks (disk_uuid, kind, label, mount_path, is_connected)
       VALUES (?, ?, ?, ?, ?) RETURNING id`
    )
    .get(opts.disk_uuid, opts.kind, opts.label, opts.mount_path, opts.is_connected) as { id: number };
  return result.id;
}

/**
 * Inserts a minimal job row and returns its id.
 */
export function insertJob(
  db: Database,
  overrides: Partial<{
    type: "scan" | "copy" | "verify" | "backup" | "diff" | "duplicate_detection";
    status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
    target_disk_id: number | null;
    created_by: "user" | "composite";
  }> = {}
): number {
  const opts = {
    type: "copy" as const,
    status: "running" as const,
    target_disk_id: null,
    created_by: "user" as const,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO jobs (type, status, target_disk_id, created_by)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(opts.type, opts.status, opts.target_disk_id, opts.created_by) as { id: number };
  return result.id;
}
