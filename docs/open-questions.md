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
- **Backup job pre-flight UI**: resolved — manual orchestration for now (scan → scan → diff → copy as separate user actions). Composite job in M11.
- **Resume re-verification semantics**: when resuming a copy after a long pause, do we re-stat/re-hash files in the persisted plan, or trust them? Per-file logic on encounter is the current direction (see `decisions.md` → Concurrency / locking → Resume robustness).
- **Disk polling cadence**: resolved — 5s (2026-05-08).
- **Schema migration tooling**: pick a lightweight pattern. fit's `PRAGMA user_version` + structured upgrade scripts is the reference.
- **Frontend state management**: resolved — React Query adopted, all pages migrated (2026-05-08).

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
- Root cause: bun:sqlite is sync, BLAKE3 update is sync (true for both the
  original `@noble/hashes` and the current `@napi-rs/blake-hash` binding —
  the napi call returns synchronously per chunk). Each "worker" returns from
  its tiny `await file.slice().arrayBuffer()` in roughly the same tick, then
  runs a long synchronous tail (hash update + the batched `INSERT … ON
  CONFLICT` transaction). With 32 of those interleaved, the loop never
  yielded long enough for Hono to accept connections.
- **Cheap fix applied**:
  - `SCAN_CONCURRENCY` 32 → 8 (less back-to-back sync work piling up).
  - Added `await new Promise(r => setImmediate(r))` between directories in `scan-job.ts::execute` so the loop breathes after each batched DB write.
- **Won't do**: Worker thread pool for hashing. Scan is already fast enough on SSD (a few seconds). Adding complexity not justified.

### Scan ETA: switch from bytes/sec to files/sec — BACKLOG

- **Problem**: ETA uses `remainingBytes / bytesPerSec` where `bytesPerSec` is derived from a 5-second rolling window of `bytesProcessed`. But `bytesProcessed` is the *sum of file sizes from stat()*, not actual bytes read off disk. A single large file (e.g. 500 GB video) increments `bytesProcessed` by 500 GB in one stat call, causing a momentary spike in the apparent rate and a corresponding ETA collapse then jump. On HDDs the effect is especially noisy because head-seek variance also affects the per-sample rate.
- **Better approach**: use `filesPerSec` (already tracked) against an inode-count total fetched once at scan start via `df -i <mountPath>`. Inode usage (`iused` = used inodes ≈ files + dirs + symlinks) is available from the OS without scanning. Scan time is dominated by stat() calls which cost roughly the same per file regardless of size, so files/sec is a far more stable predictor than bytes/sec for a scan job. Bytes/sec remains the right metric for *copy* jobs where actual data movement is the bottleneck.
- **Implementation sketch**:
  1. Add `getDiskInodeCount(mountPath)` to `disk-reads.ts` — parse `df -Pi <mountPath>` (POSIX inode output), return `iused`.
  2. Store it as `total_inodes` on the job row (or in `payload_json`) at scan start.
  3. ETA formula becomes `(totalInodes - job.itemsProcessed) / filesPerSec`.
  4. Keep bytes/sec chart and stat — just don't use it for ETA.
- **Caveat**: APFS inode counts are dynamic and may drift slightly during a long scan; treat as an estimate, not a guarantee. Good enough for ETA display.
- **Widening the rolling window** (5s → 30–60s, or EMA on the rate) is a complementary fix worth doing at the same time.

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

### M9 Diff — design locked 2026-05-09

**Flow (manual orchestration, no composite job yet):**
1. Scan source disk (existing)
2. Scan dest disk (existing)
3. Trigger diff from source disk page → "Diff against…" button → pick dest disk → creates a `diff` job
4. Browse result in the Diff tab on the source disk page
5. Trigger copy from the diff view (M10)

Composite backup job (scan→scan→diff→copy as one unit) is deferred to M11.

**Diff is a job (`type='diff'`)**. Not a synchronous query — keeping it a job gives it a status, progress, and consistent model with scan/copy/verify. Source/dest scan job ids stored in `payload_json`. "Latest diff" for a pair = most recent completed diff job for `source_disk_id` + `dest_disk_id`.

**Schema: `diff_entries` + `diff_dirs`** (replaces the old `diff_cache` / `diff_cache_entries` design). See `schema.md` for full field list.
- `kind` values: `added` / `removed` / `changed` / `present` (cleaner than the old `only_on_source` etc.)
- `path` = source path normally; dest path for `removed` entries. Always populated.
- `present` entries ARE stored in `diff_entries` (copy job needs them to know what to skip)
- `diff_dirs` materialized with the same O(files + dirs) bottom-up rollup as `recomputeAggregates` — never correlated LIKE subqueries

**UI: `DiffExplorer` component** (`apps/web/src/components/DiffExplorer.tsx`). Mockup built and iterated. Key design:
- Mirrors the existing `TreeExplorer` — same breadcrumb navigation, browse one directory at a time
- File rows: colored by kind (green=added, yellow=changed, red=removed, grey=present)
- Directory rows: diff pills (`+1,204/38 GB · ~88/3.2 GB`) + before/after (`87,412/168 GB → 88,704/209.2 GB`)
- Filter bar: All / Added / Changed / Removed with counts + bytes
- Header summary: `+N · ~N · −N · → total after copy`
- New "Diff" tab on `DiskDetailPage` (tabs: Overview / Tree / Diff / Events)

**Excludes**: hardcoded for now. Exclude editor deferred to M14 polish.

**`only_on_dest` (removed)**: shown in the diff tree as red entries. No action taken — safety model means we never delete from dest. Informational only.

### M9 Diff — implemented 2026-05-09

**Implemented:**
- `apps/api/src/db/migrations/0003_diff_tables.sql` — adds `diff` to `jobs.type` CHECK (via table recreation), drops `diff_cache`/`diff_cache_entries`, creates `diff_dirs` + `diff_entries`. `migrate.ts` wraps each migration in `PRAGMA foreign_keys = OFF/ON` so the `jobs` table recreation works cleanly.
- `apps/api/src/jobs/diff/diff-job.ts` — `DiffJobRunner`: strips mount-path prefix to compare files by **relative path** (absolute paths differ across disks). Classifies as `added/changed/present/removed`, inserts `diff_entries` in 1000-row batched transactions, rolls up `diff_dirs` bottom-up.
- `apps/api/src/routes/diff.ts` — `POST /api/disks/:id/diff`, `GET /api/disks/:id/diff` (browse tree), `GET /api/disks/:id/diff/jobs`.
- `DiffExplorer.tsx` — now reads live data via React Query; `DiffTab` on `DiskDetailPage` includes disk picker, "Run Diff" button, and polls for completion.

**Bug found by type-checker (not tests):** `new _BLAKE3(32, {})` in `hasher.ts` had args backwards — correct signature is `(opts?: Blake3Opts)`. Accidentally produced correct output at runtime because default `dkLen` is 32. Fixed to `new _BLAKE3()`.

**Key implementation note:** `diff_entries.path` and `diff_dirs.path` are always **disk-relative** (e.g. `/Documents/file.txt`), not absolute. The diff job strips `disk.mount_path` from both sides before comparing. This is what makes cross-disk diffing work — two disks at different mount points still have the same relative file layout.

**Validated 2026-05-09 — self-diff smoke test (disk diffed against itself):**
- 177,459 files processed in ~2 seconds (~88K files/sec)
- Result: 0 added / 0 changed / 0 removed / 177,459 present — correct.
- Same-disk diff is intentionally allowed by the API (a diff is read-only, so it's always safe). UI shows a warning when source = dest.
- Same-disk copy must be blocked at the API when the copy job is implemented (makes no sense, unlike diff).

**Migration gotcha — SQLite self-referencing FK declarations survive RENAME:**
Migration 0003 used the SQLite 12-step schema change (create `jobs_new` → copy → drop old → rename). An early version of the migration was applied to the DB before the intended fix (omitting self-referencing FK declarations) was in the SQL file. After `ALTER TABLE jobs_new RENAME TO jobs`, SQLite bakes the original table name (`jobs_new`) into the stored DDL for self-referencing FK columns. Since `jobs_new` no longer exists, any `db.prepare(INSERT INTO jobs …)` fails with `no such table: main.jobs_new` at prepare time (not execution time) when `foreign_keys = ON`. Fix: migration `0004_fix_jobs_self_fk.sql` repeats the rename with correct DDL (self-referencing FK columns declared as plain `INTEGER`, no FK clause). **Going forward**: whenever the `jobs` table is rebuilt via a rename, always omit self-referencing FK declarations on `parent_job_id` and `active_sub_job_id`.

### M10 Duplicate detection — implemented, testing and iterating

**What was built:**
- Duplicate file detection job (`type='duplicates'`): groups files with identical content hash across a disk's scan results.
- API endpoints for triggering the job and browsing results.
- UI tab on `DiskDetailPage` showing duplicate groups.

**Testing observations:**
- First real run found a group of **2051 identical copies** of `._crossfire.lua` — a macOS AppleDouble metadata file. These `._*` files are auto-generated by macOS when accessing external filesystems (FAT32, exFAT, NTFS) that don't support HFS+ resource forks. They're not user content; identical copies are expected and very common on backup disks. This raises the question of whether the duplicate job should offer a filter to exclude `._*` files (and potentially other macOS noise like `.DS_Store`, `__MACOSX/`). Deferred until more testing.

**Open items surfaced during testing:** TBD — iterating.

### Cross-disk diff bug — fixed 2026-05-11

**Symptom:** Diffing SSD (disk 1) against HDD (disk 2) showed 177,459 added / 0 present — every file appeared as new, no matches.

**Root cause:** `markDiskDisconnected()` set `mount_path = NULL` on the disk row. The diff job reads `mount_path` at diff time to strip the prefix from absolute file paths. With `mount_path = NULL`, the fallback was `""`, so `relPath("", "/Volumes/<disk>/file.txt")` returned the full absolute path instead of `/file.txt`. Since the HDD paths were properly relativized but the SSD paths weren't, nothing matched.

**Secondary symptom:** The SSD showed as "offline" in the UI despite being physically connected. The poller skips disks with `mount_path = NULL` (no path to probe), so it could never discover the disk was back.

**Fix:** `markDiskDisconnected()` now preserves `mount_path` — only sets `is_connected = 0`. The mount path is needed to relativize stored file paths even when the disk is offline. If the disk remounts at a different path, the poller's `markDiskConnected()` updates it.

**Test added:** `diff-job.test.ts` — "produces correct results when source disk mount_path was preserved after disconnect".

**Validated 2026-05-11:** Re-ran SSD→HDD diff after fix. Result: 153,599 present / 23,851 added / 9 changed / 1,887 removed — correct.

### Breadcrumb double-root — fixed 2026-05-11

**Symptom:** Tree view breadcrumb showed `<disk> / <disk> / <subdir> / …` — the disk root appeared twice.

**Root cause:** `buildBreadcrumb()` in `routes/tree.ts` walked up the directory chain (which includes the root dir named after the mount point basename), then unconditionally prepended a separate disk-label crumb. Both had the same display name.

**Fix:** Removed the separate prepended crumb. Instead, the root directory's name is replaced with the disk label in the breadcrumb. One entry, no duplication.

### Disk registration — volume picker — 2026-05-11

**Current:** `GET /api/disks/volumes` lists `/Volumes/*` mounts with capacity/free. Frontend `RegisterModal` shows a dropdown of available volumes; selecting one pre-fills the label from the volume name.

**History:** Briefly tried a native macOS folder picker via `osascript -e 'choose folder'`, but it only works when the browser runs on the same machine as the server. Since the tool is accessed from other devices on the local network, reverted to the volume-list approach.

**Files:**
- `disk-reads.ts`: `listVolumes()` reads `/Volumes`, enriches each with `getDiskStats()`
- `routes/disks.ts`: `GET /disks/volumes` route
- `DisksPage.tsx`: `RegisterModal` with volume dropdown
- `api/client.ts`: `api.disks.volumes()`

### UI improvements — 2026-05-11

- **Diff progress indicator**: Active diff jobs now show a progress card with status badge, elapsed time, and entries-compared count (SSE-powered via `useLiveJob`). Auto-refreshes to show the diff explorer when the job completes.
- **URL-based tab state**: Tab and diff destination disk are synced to URL search params (`?tab=diff&dest=2`). Supports deep linking and browser back/forward.
- **Diff summary**: Top-right summary next to breadcrumb now shows colored `+N ~N −N` counts plus `prevFiles/prevBytes → newFiles/newBytes` totals. Updates per-directory as you navigate (uses `currentDir` from the API response, not disk-level totals).

### Pre-commit hook — 2026-05-11

Added a tracked pre-commit hook (`.githooks/pre-commit`) that runs `tsc --noEmit` on the web app and `bun test` on the API. Configured via `git config core.hooksPath .githooks`; the `prepare` script in root `package.json` sets this automatically on `bun install`.

### Type fixes — 2026-05-11

`DiffJobSummary.status` and `DuplicateJobSummary.status` were typed as `string` instead of `Job["status"]`, causing a type error when passing to `StatusBadge`. Fixed in `api/types.ts`.

---

---

## M11 Copy job — design decisions (2026-05-12)

### No post-write hash verification during copy
The copy job computes the full BLAKE3 hash inline during the streaming read (it's free — every byte flows through the hasher). But it does NOT re-hash the temp file after writing to verify what landed on disk. The verify job is the authoritative correctness check for on-disk integrity. Removing this simplifies `copyFileAtomic` significantly — no `expectedSampledHash` parameter, no `HashMismatchError` path, no `computeSampledHash` call on the temp file.

### Source re-validation before each copy
Before copying each file, the copy job: (1) re-stats the source file (mtime + size), comparing to the stored `files` row; (2) re-computes the sampled hash on the source file, comparing to the stored `sampled_hash`. If either differs → skip with `skipped_source_changed`. This prevents copying stale data. The overhead is minimal (SSD reads, ~6 small slices for sampled hash).

### Dest file exists → hash compare, never overwrite
If the dest path already exists: compute its sampled hash and compare to source. Match → `skipped_already_present`. Mismatch → `error_hash_mismatch`, log both hashes. Never overwrite under any circumstance.

### Disk space: pre-flight fails, periodic pauses
Pre-flight check sums all pending bytes and compares to free space + 1GB margin. Insufficient → fail immediately (copying 10 files out of 50,000 isn't useful). During copy, re-check every 10 minutes. Below 500MB → auto-pause (partial progress is worth keeping). ENOSPC during write → auto-pause.

### No excludes for now
Full backup — all files from the diff are copied. Exclude patterns deferred to M14 (exclude editor UI).

### Orphaned temp files: track, don't move or delete
On resume, orphaned temp files (`.backup-tmp-<uuid>`) from interrupted copies are logged and the copy_item is reset to `pending`. The temp file is left on disk. Cleanup/quarantine tooling is a future milestone (M14).

### Cancel leaves dirty state
Cancelling a copy job leaves in_progress items and orphaned temp files. Cleanup tooling deferred.

### Per-chunk progress for large files
`copyFileAtomic` accepts an `onChunkWritten` callback so the copy runner can report bytes-level progress within a single large file. This feeds the speed charts and gives meaningful ETA during multi-GB video copies.

### Upsert dest files row after copy
After a successful copy, the runner upserts a `files` row on the dest disk (stat after rename for mtime, reuse source `sampled_hash`, store computed `full_hash`). This keeps the dest disk's file index current without requiring a re-scan.

### Copy concurrency = 1 (sequential)
Dest is a 5400rpm HDD. Parallel writes cause head thrashing and destroy throughput. Sequential copy saturates the HDD write speed. The natural hardware concurrency (OS I/O pipelining between SSD reads and HDD writes) happens at the OS level, not the application level.

---

## Implementation notes (added during development)

### M12 Write speed test job — implemented 2026-05-13

Goal: benchmark destination disk write throughput through Waypoint's own write
pipeline, after the first real copy job proved slower than expected.

Implemented behavior:
- New `write_speed_test` job type targets one connected disk and acquires the same per-disk write lock used by copy jobs.
- The job writes generated data to `.waypoint-test-copy-[uuid]`; files are intentionally left for manual deletion.
- Supports `null` data for raw write-path testing and `random` data when compression/sparse-file behavior needs to be avoided.
- Uses the same audited temp→rename streaming helper path as `copyFileAtomic`, with per-chunk progress feeding the existing bytes/sec samples.
- Pause/resume checkpoints run inside the chunk loop, so large tests pause promptly.
- Frontend launch lives on the disk overview header; job details show target file, mode, written bytes, remaining bytes, ETA, and write speed chart.

### Scan warnings/errors banner in Tree view — BACKLOG

- **Problem**: When a scan encounters per-file errors (stat/hash failures, permission denied), the file is silently absent from the index. The errors are logged as job events, but a user who doesn't check the Events tab could miss files that are never backed up.
- **Proposed fix**: Add a banner at the top of the Tree view that pulls job events for the current scan. If there are any warning/error events, show "X errors / Y warnings" with a link to the Events tab (filtered to that scan). This makes scan problems immediately visible without requiring the user to proactively check events.
- **Scope**: Frontend-only change in `TreeExplorer.tsx` or the Tree tab wrapper. Backend already has `GET /api/disks/:id/events` with job filtering.

### Waypoint temp file cleanup — BACKLOG

- **Problem**: Two sources of Waypoint-created temp files can accumulate on backup disks:
  1. **Copy job orphans** (`.backup-tmp-<uuid>`): left behind when a copy is interrupted mid-file. Currently detected and logged on resume, but never cleaned up.
  2. **Write speed test files** (`.waypoint-test-copy-<uuid>`): intentionally left for manual deletion after benchmarking.
- **Proposed fix**: A user-triggered "Clean up Waypoint files" action on the disk page that:
  1. Scans the disk root for files matching `.backup-tmp-*` and `.waypoint-test-copy-*`.
  2. Shows a confirmation dialog listing every file and its size.
  3. On confirm, moves files to `.waypoint-quarantine/` on the same disk (consistent with the quarantine-not-delete safety model in `decisions.md`).
- **Note**: This supersedes the narrower "orphaned temp file cleanup" item mentioned in `decisions.md` § Acknowledged review gaps. The `.write-speed-tmp-*` pattern (used during atomic writes for speed tests) should also be included.

### Speed test jobs moved to Worker threads — 2026-05-15

Both `read_speed_test` and `write_speed_test` jobs now run their heavy work in
Bun Worker threads. Without this, the main-thread event loop was completely
starved during benchmarks and the API froze (no progress updates, no page loads).

**Architecture:**
- Worker scripts: `jobs/read-speed/read-speed-worker.ts`, `jobs/write-speed/write-speed-worker.ts`
- Workers do all filesystem I/O and BLAKE3 hashing off the main thread
- Main thread handles: job lifecycle, DB queries, lock manager, SSE progress
- Communication via `postMessage`: start/pause/resume/cancel inbound, progress/done/error outbound
- Workers replicate `disk-writes.ts` guardrails inline (path containment, exclusive create) since they can't share main-thread module singletons

**Read speed test results (test SSD, 2026-05-15):**
- Initial measurement with `@noble/hashes` pure-JS BLAKE3: ~260 MB/s effective
  throughput on a large video file. The SSD's raw sequential read is several
  times higher, so the JS hasher was the bottleneck, not the disk.
- Resolved 2026-05-16 by swapping to `@napi-rs/blake-hash` — see next section.

### BLAKE3 hashing throughput — DONE 2026-05-16

- **Problem**: Pure-JS BLAKE3 via `@noble/hashes` topped out at ~260 MB/s,
  making the read-speed test, scan, copy, and (future) verify jobs CPU-bound
  rather than I/O-bound on SSDs.
- **Decision**: Swapped to `@napi-rs/blake-hash`, a maintained native Rust
  (NAPI) binding to the official BLAKE3 crate with SIMD/NEON. Byte-identical
  BLAKE3 output, so the DB stays valid — no rehash needed.
- **Why not other options that were on the table:**
  - `hash-wasm` (WASM): faster than noble (~480 MB/s) but no WASM SIMD, still
    capped well below disk speed.
  - `bun:ffi` + libblake3: another ~2–6× faster per call, but `bun:ffi` is
    marked experimental and we'd vendor binaries per platform. Saved as a
    fallback if napi-rs ever becomes the bottleneck — at MB-scale chunks the
    NAPI overhead is negligible, so this isn't expected.
  - `b3sum` CLI: loses streaming integration, adds an install dependency.
  - `Bun.CryptoHasher` SHA-256: ties napi for throughput but isn't BLAKE3,
    would force a full DB rehash, and offers no upside.
- **Benchmarks (post-swap, on the test SSD, 9 GB media file):**
  - raw read ceiling: 891.9 MB/s
  - `@noble/hashes` (before): 273.8 MB/s
  - `@napi-rs/blake-hash` (after): 891.9 MB/s — saturates the disk
- **Production read-speed test (5 files, ~75 GB total):** average 844 MB/s
  through the unmodified job runner, end-to-end.
- **Bench scripts checked in:** `scripts/bench-raw-read.ts` (ceiling probe)
  and `scripts/bench-hash.ts` (variant comparison) — keep them around for
  re-running if napi-rs is ever superseded.

### fullHash scan mode — DONE 2026-05-16

Now that BLAKE3 saturates disk read speed, computing the full content hash
during a whole-disk scan is viable (not just during copy). Added an opt-in
mode rather than making it default — most scan use cases still only need
sampled hashing for change detection.

- **API**: `POST /api/disks/:id/scan` accepts `{ fullHash: true }` in the
  body. Without the flag, scan behaviour is unchanged. UI integration is
  deferred — for now this is triggered programmatically (curl or a future
  button on the disk page).
- **Walker behaviour**: in addition to computing `sampled_hash`, each file
  is streamed through BLAKE3 and the digest stored in `files.full_hash`.
- **Reuse logic** (applies to all scans, not just fullHash):
  - `sampled_hash` is reused from the previous scan when `mtime + size` are
    unchanged. Same as before.
  - `full_hash` is reused when the *sampled_hash* itself matches the prior
    row's. The sampled hash is a content fingerprint, so equality implies
    extremely high probability that bytes are identical — stronger than
    mtime+size, which a plain `touch` would invalidate even though content
    is the same.
  - Carry-forward fires in non-fullHash scans too, so accumulated
    full_hash data is preserved across plain re-scans rather than being
    silently dropped when a new scan row is created.
- **Cost on a fresh full-hash scan** ≈ reading every byte once
  (~800 MB/s on the test SSD, measured 870 MB/s steady-state during the
  first production run on 2026-05-16).

### User collaboration preferences

- Testing flow is **UI-only**. Do not give curl commands as testing instructions. Curl is only acceptable for backend-state debugging when explicitly asked.
