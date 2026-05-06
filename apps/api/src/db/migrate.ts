import { Database } from "bun:sqlite";
import path from "path";
import { readdirSync, readFileSync } from "fs";

const MIGRATIONS_DIR = path.join(import.meta.dir, "migrations");

export function runMigrations(db: Database): void {
  const currentVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic — 0001_, 0002_, etc.

  let applied = 0;
  for (const file of files) {
    const version = parseMigrationVersion(file);
    if (version === null) {
      console.warn(`Skipping migration file with unexpected name: ${file}`);
      continue;
    }
    if (version <= currentVersion) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");

    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    })();

    if (!isSilent()) console.log(`Applied migration ${file}`);
    applied++;
  }

  if (applied === 0 && !isSilent()) {
    console.log(`Database schema up to date (version ${currentVersion})`);
  }
}

const isSilent = () => process.env.NODE_ENV === "test";

function parseMigrationVersion(filename: string): number | null {
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
