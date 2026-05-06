# Waypoint

A personal backup tool for rotating cold-storage USB drives.

**Use case:** SSD source → multiple HDDs (cold storage, manually rotated — only one connected at a time).

---

## What it does

- Scans disks and builds a queryable SQLite file index
- Compares source vs. destination to identify what needs copying
- Copies files atomically (temp→rename, inline BLAKE3 verification)
- Everything is pausable and resumable mid-operation — copying terabytes to a slow HDD takes hours
- Rich web UI for disk inspection, backup state, and job monitoring
- SQLite database is independently queryable with any standard tool

**Safety model:** the tool never calls `unlink`/`rm` on user files. Cleanup moves files to `.waypoint-quarantine/` on the same disk; the user deletes from quarantine via Finder.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| API | [Hono](https://hono.dev) |
| Database | `bun:sqlite` (WAL mode) |
| Hashing | BLAKE3 (sampled for speed) |
| Frontend | React + Vite |
| Progress | Server-Sent Events |

---

## Project structure

```
apps/
  api/     Bun + Hono server
    src/
      db/          SQLite client, migration runner, migrations/
      disks/       Disk identity (.waypoint-disk-id), polling, registry
      jobs/        JobManager, JobRunner base class, SSE registry
      locks/       Per-disk write lock manager
      routes/      HTTP route handlers
  web/     React + Vite frontend
docs/      Design docs (brief, decisions, schema, research)
```

---

## Development

Requires [Bun](https://bun.sh/docs/installation).

```bash
bun install        # install dependencies (from repo root)
bun run dev        # start API (:3000) + Vite dev server (:5173)
```

```bash
cd apps/api
bun run test       # run test suite
bun run test:watch # watch mode
```

---

## Design docs

All design decisions are locked in [`docs/`](docs/):

- [`docs/START-HERE.md`](docs/START-HERE.md) — project overview, current status, milestone map
- [`docs/decisions.md`](docs/decisions.md) — authoritative design decisions (stack, safety, hashing, jobs, schema)
- [`docs/schema.md`](docs/schema.md) — SQLite schema reference
- [`docs/brief.md`](docs/brief.md) — original project brief and requirements

---

## Status

See [`docs/START-HERE.md`](docs/START-HERE.md) for current implementation progress.
