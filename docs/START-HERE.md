# Waypoint — Start Here

Personal backup tool for cold storage drives. SSD source → multiple HDDs (one connected at a time, manually rotated). Custom build — no existing tool covers all requirements.

**Safety is the top priority.** Backup operations are additive-only: the tool never overwrites destination files and never propagates source deletions to backups. Deletion is allowed only in narrow, human-initiated flows with server-enforced guardrails: duplicate cleanup requires an explicitly kept identical copy to remain, and future Waypoint temp-file cleanup will be limited to explicitly reviewed paths that match tightly allowed temp-file patterns. All write/move/rename operations are gated by an existence check and covered by tests asserting no-overwrite.

---

## Doc map

| Doc | Purpose |
|---|---|
| `brief.md` | Original project brief — hardware context, requirements, existing-tools research, original architecture sketch. Most useful for "why" questions; some details are now superseded by `decisions.md`. |
| `decisions.md` | Locked design decisions. The authoritative source for stack, safety constraints, hashing, atomic writes, concurrency, jobs, excludes, etc. |
| `schema.md` | Working SQLite schema. Tables, fields, indices, intentional absences. |
| `open-questions.md` | Record of resolved design questions + items deferred to implementation. |
| `research-fit-gdu.md` | Findings from fit (C++ file integrity) and gdu (Go disk analyzer). Patterns to borrow. |
| `research-spacedrive.md` | Findings from Spacedrive v2 (Rust file manager). The closest architectural reference. |
| `research-correctness.md` | Findings from restic + borg: atomic writes, fsync, verification, macOS xattrs. |

---

## Status

**Implementation in progress.** Design phase complete; milestones 1–12 done plus an out-of-band read-speed-test job, append-only scan snapshots, and an opt-in fullHash scan mode. FullHash scans now provide the planned deep-verification workflow when paired with diffs, so the next milestone map will be revisited before M13 work begins. See `open-questions.md` for details.

**Stack**: TypeScript + Bun, Hono (HTTP), React + Vite (UI), `bun:sqlite`, BLAKE3 via `@napi-rs/blake-hash` (saturates SSD read speed), SSE for progress.

**Scale baseline measured**: ~173K files / ~3.55TB on the source SSD. Standard SQLite indices are sufficient.

**Test suite**: `bun test` in `apps/api/` — 209 tests across 15 files. Pre-commit hook runs `tsc --noEmit` (web) + `bun test` (API) on every commit.

**Diagnostic trace**: when `WAYPOINT_TRACE` is unset or non-zero, the API writes JSONL trace lines to `/tmp/waypoint-trace.log` (path overridable via `WAYPOINT_TRACE_PATH`). Includes `loop_stall` events whenever the main event loop blocks >250ms. Used to root-cause the M6 freeze (correlated-LIKE end-of-scan UPDATE, see `open-questions.md`). Set `WAYPOINT_TRACE=0` to disable.

---

## Milestone map

| # | Name | Status |
|---|---|---|
| 1 | Project skeleton (monorepo, Hono boot, Vite dev proxy, healthcheck) | ✅ Done |
| 2 | SQLite + migrations (WAL, migration runner, full schema) | ✅ Done |
| 3 | Disk identity & registration (dotfile UUID, `df` polling, disk registry API) | ✅ Done |
| 4 | Locking primitive (per-disk write lock, DB-mirrored, unit tested) | ✅ Done |
| 5 | Job framework (status machine, pause/resume/cancel, SSE progress stream) | ✅ Done |
| 6 | Scan job — resumable walk queue, BLAKE3 sampled hash, batched writes | ✅ Done |
| 7 | Web UI shell (disk list, job list, live SSE progress) | ✅ Done |
| 8 | Tree view (virtualized disk explorer, materialized aggregates) | ✅ Done |
| 9 | Diff (diff job, diff_entries + diff_dirs, DiffExplorer UI) | ✅ Done |
| 10 | Duplicate file detection (job, API, UI tab) | ✅ Done |
| 11 | Copy job (temp→rename, inline full hash, resume-safe, full UI) | ✅ Done |
| 12 | Write speed test job (generated data → `.waypoint-test-copy-[uuid]`, pause/resume, throughput UI) | ✅ Done |
| 13 | Verify workflow (superseded candidate: fullHash scans + diff may replace a dedicated job) | 🔲 |
| 14 | Guarded cleanup (orphan temp files with reviewed-path + filename-pattern deletion rules) | 🔲 |
| 15 | Polish (ETAs, exclude editor, error review UI, SMART data) | 🔲 |
| 16 | Backup composite (scan→scan→diff→copy pipeline, pause-as-unit) | 🔲 |

The scan job (M6) is the architectural keystone — if its resumability is wrong, everything else is wrong.

---

## Backlog

Improvements planned but not yet scheduled into a milestone.

| Item | Notes |
|---|---|
| Move duplicate detection off the main thread | Phase 1 GROUP BY and Phase 3 batch inserts block the event loop with synchronous SQLite. Server becomes very slow during large jobs. Options: Bun worker thread with its own SQLite connection, or paginated Phase 1 query with yields. (Speed-test jobs already moved to workers.) |
| Scan ETA: switch from bytes/sec to files/sec + inode count | `bytesProcessed` is the sum of stat'd file sizes, not bytes read — a single large file causes a massive rate spike. Scan time is uniform per-inode (stat cost), so `filesPerSec` against `df -i` inode count is a much more stable ETA. Also consider widening the 5s rolling window or using an EMA. |
| Copy job: rich insight view (match scan job pattern) | Same philosophy as scan jobs — show a rich view of all available job insights in both the diff view (where the copy is initiated) and the job details page. Reuse the same component. |
| Duplicate cleanup as a job with progress | Cleanup re-checks fresh sampled hashes for the kept + deleted files before unlinking. It should become a proper job with progress/pause/resume so the UI shows status rather than hanging on a single POST for large batches. |
| fullHash scan UI | Backend supports `POST /:id/scan { fullHash: true }`; expose it as a toggle on the disk page. |

Recently completed backlog:

- Per-disk exclusion list for duplicate detection: `excluded_paths` table, `/api/disks/:id/excluded-paths` CRUD router, Notes-tab section, and "Exclude folder…" button on duplicate-group cards. Files at or under an excluded path are filtered from both the Phase 1 GROUP BY and the per-group member lookups; scan/diff/copy are unaffected.

- macOS metadata noise (`.DS_Store`, `._*`) and Waypoint disk identity files (`.waypoint-disk-id`) are globally excluded from scans, diffs, duplicate detection, and copy jobs.
- Tree view syncs the current folder path with the URL and browser history.
- Copy job status on the diff view links to the job details page.
- Copy job progress shows pending files/bytes, ETA, and per-file byte progress for large files.
- Copy job milestone marked complete after successful manual copy testing.
- Write speed test job writes generated null/random data to `.waypoint-test-copy-[uuid]`, uses the same temp→rename streaming write path as copy, supports pause/resume, and shows live write-speed states/charts.
- Read speed test job (Bun Worker, full BLAKE3 hash over the N largest files from the latest scan).
- Append-only scan snapshots: each scan creates independent file/directory rows keyed by `scan_id`, so previous scan states are queryable for diff/history rather than overwritten.
- BLAKE3 swapped from pure-JS `@noble/hashes` (~265 MB/s) to native `@napi-rs/blake-hash` (~890 MB/s, saturates SSD). Byte-identical output, no DB rehash. Scan/copy/read-speed-test now disk-bound rather than CPU-bound.
- Opt-in `fullHash` scan mode (`POST /:id/scan { fullHash: true }`) that re-reads every byte and writes a fresh `full_hash` for every file; plain re-scans can still carry `full_hash` forward when sampled hashes match.

---

## Key things to keep in mind

- **Backup behavior is additive-only.** Source deletions are never mirrored onto destination disks, and existing destination files are never overwritten.
- **Deletion is allowed only for narrow guarded workflows.** Every destructive flow must be human-initiated from the web UI, must echo back the exact reviewed paths, and must have a use-case-specific server-side proof before deletion.
- **Duplicate cleanup** proves that an identical kept copy remains.
- **Waypoint temp-file cleanup** will only allow explicitly reviewed paths that match tightly whitelisted temp-file naming patterns.
- **All write/move/rename operations check existence first** and are tested to assert no-overwrite. Code-level invariant.
- **All errors are logged per-file in SQLite** — nothing silent, everything retryable.
- **Permission errors during scans are non-fatal** (logged, indexing continues).
- **Scans index everything**; exclusion patterns apply only at copy time.
- **Database queries need an explicit index story.** Most production queries should have deliberate backing indexes; if a query intentionally scans or cannot use an index well, call out that tradeoff explicitly.
- **Resume robustness**: copy logic always re-checks per-file state at the destination on encounter (does it exist? hash match?). Don't trust the persisted plan blindly.
- The project is named **Waypoint**. GitHub: github.com/gaelollivier/waypoint.
