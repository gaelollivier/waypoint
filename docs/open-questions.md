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

---

## Surfaced during manual testing — 2026-05-07

First UI-driven test scan run on the source SSD. Surfaced the following items, captured here so we don't lose them:

### Job rehydration after server restart — DONE

- Bug surfaced when resuming a scan that was paused before a server restart: the in-memory runner registry is gone, so the resume endpoint returned 409 "Job is not active in this process".
- Fix in `routes/jobs.ts`: resume now constructs a fresh `ScanJobRunner` for the same `jobId` when no in-process runner exists. `JobRunner.start()` accepts `paused → running` (the transition table allows it, and `started_at` is preserved), and the walker's `initOrResumeQueue()` already handles a non-empty walk queue.
- Cancel was hit by the same problem; fix is simpler — just transition the DB row to `cancelled` since there's no runner to clean up.
- Currently only scan jobs are rehydratable. Copy/verify don't exist yet. Backup composite rehydration is a v1.x concern (it tracks an active sub-job by id; the rehydration logic will need to recurse).
- This aligns with `decisions.md` → Jobs: "Crash mid-job is treated the same as pause."

### Performance — DONE (waiting on benchmark)

- Walker rewritten in `apps/api/src/jobs/scan/walker.ts`: (1) async `readdir`, (2) one batched `SELECT … IN (?, ?, …)` per directory for the mtime+size shortcut, (3) worker-pool concurrency for the per-file stat+hash phase.
- Backwards compatible with paused scans (no schema or `scan_walk_queue` changes).
- **Open**: SCAN_CONCURRENCY is hardcoded at 8 (was 32, lowered after the freeze incident below). Should be tuned by `disk.kind` once we benchmark — HDDs will likely want concurrency=1 or 2 to avoid thrash. Defer until we actually scan an HDD.

### `recomputeAggregates` end-of-scan freeze — DONE 2026-05-08

- Symptom: walker phase finished cleanly (~13s for 177K files / 3.7K dirs, ~12.8k files/sec) but the API was wedged for **179s** afterwards before the job flipped to `completed`. `loop_stall` trace fired with `drift_ms ≈ 179687`.
- Root cause: the old `recomputeAggregates` ran a single synchronous SQL UPDATE with two correlated `LIKE 'dir/%'` subqueries per directory, scanning the whole files table for every directory: ~3,769 × 177,459 ≈ 670M comparisons in one sync `bun:sqlite` call. The original doc comment estimated O(dirs²) "well within budget" — the estimate ignored the per-directory file scan and underweighted bun:sqlite's main-loop blocking.
- Fix: O(files + dirs) algorithm. (1) `SELECT directory_id, COUNT(*), SUM(size_bytes) FROM files GROUP BY directory_id` for direct totals; (2) load `(id, parent_id)` for all dirs; (3) compute depth, sort deepest-first, accumulate each dir's totals into its parent in JS; (4) write back in one transaction yielding to the event loop every 500 rows.
- Memory cost is O(dirs) — the GROUP BY result is one row per directory, not per file. At ~10x file count (~37K dirs) this is ~13 MB; at ~100x (~370K dirs) ~130 MB. Comfortable up to a few hundred thousand directories before chunking would be worth considering.
- Result: aggregates phase went from 179,691ms → 25ms (~7,200x). API stayed responsive throughout the scan (no `loop_stall` events).
- Instrumentation kept: `apps/api/src/diag/trace.ts` writes JSONL trace events to `/tmp/waypoint-trace.log`. Logs include `scan_*`, `aggregates_done` with phase breakdown (group/depth/rollup/write ms), and a `loop_stall` detector that fires when the main loop blocks >250ms. Trace is gated by `WAYPOINT_TRACE` env var (set to `0` to disable).

### Event-loop starvation during fast scans — 2026-05-07

- Symptom: with SCAN_CONCURRENCY=32 the SSD scan hit ~12k files/sec, then the API stopped responding to **any** HTTP request (healthz timed out, jobs list timed out). Once the scan finished the API became responsive again. Process was alive throughout — pure event-loop starvation.
- Root cause: bun:sqlite is sync, `@noble/hashes/blake3` is sync pure JS. Each "worker" returns from its tiny `await file.slice().arrayBuffer()` in roughly the same tick, then runs a long synchronous tail (BLAKE3 update + the batched `INSERT … ON CONFLICT` transaction). With 32 of those interleaved, the loop never yielded long enough for Hono to accept connections.
- **Cheap fix applied**:
  - `SCAN_CONCURRENCY` 32 → 8 (less back-to-back sync work piling up).
  - Added `await new Promise(r => setImmediate(r))` between directories in `scan-job.ts::execute` so the loop breathes after each batched DB write.
- **Won't do**: Worker thread pool for hashing. Scan is already fast enough on SSD (a few seconds). Adding complexity not justified.

### Job progress sampling — DONE 2026-05-08

- `JobRunner._flush` appends `(t, items, bytes)` samples (cumulative) to a bounded buffer (`MAX_SPEED_SAMPLES=500`). Buffer uses **merge-on-overflow**: when full, odd-indexed entries are dropped (halving resolution) before appending. This keeps the full job history at ≤500 entries regardless of duration — a 30s scan stays at ~250ms resolution, a 10-day copy coarsens gracefully to ~25min resolution.
- Frontend derives rates from adjacent sample pairs. `JobDetails` renders both files/sec and bytes/sec as Recharts `AreaChart`s. Charts appear inside the active job panel on `DiskDetailPage` and on `JobDetailPage`.
- **SCAN_CONCURRENCY tuning per disk.kind**: backlog. Revisit after testing scan on HDD with perf profiling.

### Disk registration — DONE

- **Dropped the `role` (source/destination) field.** Migration `0002_drop_disk_role.sql`. The intent ("don't copy onto a source disk") is better served by real, data-driven checks at copy time (still TODO when the copy job lands):
  - Free-space check at the destination before starting a copy.
  - Existence check per file at the destination — never overwrite (already a hard safety constraint, see `decisions.md`).
- **Auto-detect `kind` (ssd/hdd).** Implemented in `apps/api/src/disks/detect.ts` via `diskutil info <mountPoint>`. Falls back to `hdd` (more conservative for I/O concurrency tuning) on any failure.
- **Volume picker for "Register disk".** Implemented: `GET /api/disks/volumes` lists `/Volumes/*` mounts with capacity and a flag indicating if the volume already has a `.waypoint-disk-id` dotfile. Frontend `RegisterModal` uses it; manual path entry is no longer needed.

### Job UI + Disk view — DONE (updated 2026-05-08)

- **UX architecture**: `DiskDetailPage` is the primary surface. `JobDetailPage` is debug-only. All job details, charts, and controls are accessible from the disk page.
- **`components/JobDetails.tsx`** — reusable component used in both `DiskDetailPage` (active job section in Overview tab) and `JobDetailPage`. Contains: job controls (pause/resume/cancel), stats grid, progress bar, files/sec chart, bytes/sec chart (Recharts AreaChart).
- **`DiskDetailPage` Events tab** — now disk-scoped: shows all `job_events` across all jobs on this disk, reverse-chronological. Filterable by level (all/error/warning/info) and by job. Backend: `GET /api/disks/:id/events`. Refreshes every 3s when a job is active.
- **React Query**: all data fetching uses `@tanstack/react-query`. `useLiveJob` pumps SSE updates into the RQ cache (`queryClient.setQueryData`). Disk list, job list, disk events all use `useQuery` with appropriate `refetchInterval`.
- **Disk poll cadence**: 10s → 5s (`apps/api/src/disks/poll.ts`).
- `lib/useLiveJob.ts` — SSE stream + 1Hz tick + optional event polling. Sources job data from React Query cache.
- `components/TreeExplorer.tsx` — virtualized tree explorer, reachable only through the disk detail Tree tab.
- `lib/format.ts` — shared formatting (bytes, rates, durations, dates).

### User collaboration preferences

- Testing flow is **UI-only**. Do not give curl commands as testing instructions. Curl is only acceptable for backend-state debugging when explicitly asked.
