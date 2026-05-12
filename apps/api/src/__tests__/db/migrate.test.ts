import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../db/migrate";

const EXPECTED_TABLES = [
  "copy_items",
  "diff_dirs",
  "diff_entries",
  "directories",
  "disk_excludes",
  "disk_locks",
  "disks",
  "duplicate_group_files",
  "duplicate_groups",
  "files",
  "job_events",
  "jobs",
  "meta",
  "quarantine_items",
  "scan_walk_queue",
  "verify_items",
];

function getTables(db: Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function getUserVersion(db: Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("runMigrations", () => {
  it("creates all expected tables on a fresh database", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    expect(getTables(db)).toEqual(EXPECTED_TABLES);
  });

  it("sets user_version to the latest migration after migration", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(getUserVersion(db)).toBe(5);
  });

  it("is idempotent: running twice does not error or duplicate tables", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    runMigrations(db); // second run — should be no-op
    expect(getTables(db)).toEqual(EXPECTED_TABLES);
    expect(getUserVersion(db)).toBe(5);
  });

  it("enforces foreign keys (PRAGMA foreign_keys = ON)", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // Inserting a file with a non-existent disk_id should fail
    expect(() =>
      db
        .prepare(
          `INSERT INTO files (disk_id, directory_id, name, path, size_bytes, mtime)
           VALUES (999, 999, 'x', '/x', 0, '2024-01-01')`
        )
        .run()
    ).toThrow();
  });

  it("creates indices (spot-check a few)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(indices).toContain("files_disk_path");
    expect(indices).toContain("files_sampled_hash");
    expect(indices).toContain("jobs_type_status");
    expect(indices).toContain("directories_disk_path");
    expect(indices).toContain("scan_walk_queue_job_status");
  });
});
