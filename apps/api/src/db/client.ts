import { Database } from "bun:sqlite";
import path from "path";
import { runMigrations } from "./migrate";
import { createWaypointDataDirectory } from "../fs/disk-writes";

const DB_FILENAME = "waypoint.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbPath =
    process.env.DB_PATH ??
    path.join(createWaypointDataDirectory(), DB_FILENAME);

  _db = new Database(dbPath, { create: true });

  // Safety and performance pragmas — applied before migrations
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(_db);
  clearStaleLocks(_db);

  console.log(`Database open: ${dbPath}`);
  return _db;
}

function clearStaleLocks(db: Database): void {
  // Any disk_locks row held by a job in a terminal status is stale — drop it.
  // Also clears rows where the job no longer exists (crash scenario).
  const cleared = db
    .prepare(
      `DELETE FROM disk_locks
       WHERE held_by_job_id IN (
         SELECT id FROM jobs
         WHERE status IN ('completed', 'failed', 'cancelled')
       )
       OR held_by_job_id NOT IN (SELECT id FROM jobs)`
    )
    .run();

  if (cleared.changes > 0) {
    console.warn(`Cleared ${cleared.changes} stale disk lock(s) on startup`);
  }
}
