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

**Safety model:** normal backup behavior is additive-only: Waypoint never overwrites destination files and never propagates source deletions to backups. Deletion is allowed only for narrow, human-initiated flows with server-enforced guardrails: duplicate cleanup requires a verified kept copy to remain, and future Waypoint temp-file cleanup will be limited to explicitly reviewed paths that match tightly allowed temp-file patterns.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| API | [Hono](https://hono.dev) |
| Database | `bun:sqlite` (WAL mode) |
| Hashing | BLAKE3 via `@napi-rs/blake-hash` (sampled per file, optional full-hash scan mode) |
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

Run everything from the repo root — the root `package.json` fans out to both
workspaces, so you never need `cd apps/...` for the common loop:

```bash
bun install         # install dependencies
bun run dev         # API (:3000) + Vite dev server (:5173)
bun run typecheck   # tsc --noEmit in apps/api and apps/web
bun run test        # API test suite (no web tests yet)
bun run test:watch  # watch mode
bun run build       # production build of both workspaces
```

The same scripts exist inside each workspace (`apps/api`, `apps/web`) if you
want to scope to one — but prefer the root commands so the cadence stays
consistent and CI matches local. Avoid invoking `tsc`, `vite`, or `bun --watch`
directly; if something is missing, add a script rather than working around it.

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
