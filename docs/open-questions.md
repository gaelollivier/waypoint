# Open Questions & Follow-up Items

All v1 design questions are resolved. This file is kept as a record of how each was decided. New design questions that surface during implementation should be added below.

---

## Resolved during the design phase (2026-04 → 2026-05)

### Higher-level alignment — RESOLVED

- **Pipeline shape**: `backup` is a composite job orchestrating scan(source) → scan(dest) → diff → copy(missing/changed). Verify is NOT auto-chained. Primitives can also be invoked individually. See `decisions.md` → Jobs.
- **Scan vs backup boundary**: backup composite always runs fresh scans of both ends before copying. Standalone scans are explicit user actions for inspection.
- **State topology**: host DB only in v1. No on-disk sidecars. See `decisions.md` → Storage format.
- **Scale**: measured 177K files / 3.5TB on the source SSD. Comfortable for SQLite with standard B-tree indices. See `decisions.md` → Scale baseline.
- **Job concurrency**: write lock per disk; readers always allowed; paused write lock allows readers. See `decisions.md` → Concurrency / locking.

### 1. fsync strategy during file copies — RESOLVED

No per-file fsync. Safety chain = temp→rename + inline hash + verify job. See `decisions.md` → Atomic writes.

### 2. Walk queue and resumable scanning — RESOLVED

Persisted walk queue (`scan_walk_queue` table). One transaction per directory. `in_progress` rows are re-queued on resume. See `schema.md` → `scan_walk_queue` and `decisions.md` → Excludes.

### 3. Hashing strategy and performance — RESOLVED

Sampled BLAKE3 by default. Full BLAKE3 computed for free during copy and stored opportunistically. mtime+size as the free first filter for re-scans. Full-verify mode deferred to v1.x. See `decisions.md` → Hashing.

### 4. Orphaned temp files — RESOLVED

Detect at start of every copy job + via a UI button. The "cleanup" action MOVES orphans to `.waypoint-quarantine/` on the same disk — never deletes. See `decisions.md` → Safety constraints and `schema.md` → `quarantine_items`.

---

## Deferred to implementation phase (likely to surface)

These weren't blockers for design alignment but will need decisions during build:

- **`*_items` retention policy**: how long to keep `copy_items` / `verify_items` rows after a job completes. Default for now is "keep indefinitely"; revisit if storage matters.
- **Backup job pre-flight UI**: how the user reviews the diff tree before kicking off the copy phase, and how excludes are edited at that moment.
- **Resume re-verification semantics**: when resuming a copy after a long pause, do we re-stat/re-hash files in the persisted plan, or trust them? Per-file logic on encounter is the current direction (see `decisions.md` → Concurrency / locking → Resume robustness).
- **Disk polling cadence**: how often to poll `df` for connect/disconnect events. Likely 2-5s.
- **Schema migration tooling**: pick a lightweight pattern. fit's `PRAGMA user_version` + structured upgrade scripts is the reference.
- **Frontend state management**: React + Vite chosen, but no opinion yet on Zustand / Jotai / React Query / etc. Decide when the first real cross-component state appears.
