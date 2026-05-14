# Waypoint — Start Here

Personal backup tool for cold storage drives. SSD source → multiple HDDs (one connected at a time, manually rotated). Custom build — no existing tool covers all requirements.

**Safety is the top priority.** The tool never calls `unlink`/`rm` on user files. All "cleanup" operations move files to a quarantine directory; the user does final deletions themselves. All write/move/rename operations are gated by an existence check and covered by tests asserting no-overwrite.

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

**Implementation in progress.** Design phase complete; milestones 1–11 done. M11 (copy job) complete. Next up: M12 — verify job. See `open-questions.md` for details.

**Stack**: TypeScript + Bun, Hono (HTTP), React + Vite (UI), `bun:sqlite`, BLAKE3, SSE for progress.

**Scale baseline measured**: ~177K files / ~3.5TB on the source SSD. Standard SQLite indices are sufficient.

**Test suite**: `bun test` in `apps/api/` — 102 tests across 8 files. Pre-commit hook runs `tsc --noEmit` (web) + `bun test` (API) on every commit.

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
| 11 | Copy job (temp→rename, inline full hash, resume-safe, full UI) | 🔜 In progress |
| 12 | Verify job (re-hash files, surface mismatches) | 🔲 |
| 13 | Quarantine & cleanup (orphan temp files → .waypoint-quarantine/) | 🔲 |
| 14 | Polish (ETAs, exclude editor, error review UI, SMART data) | 🔲 |
| 15 | Backup composite (scan→scan→diff→copy pipeline, pause-as-unit) | 🔲 |

The scan job (M6) is the architectural keystone — if its resumability is wrong, everything else is wrong.

---

## Backlog

Improvements planned but not yet scheduled into a milestone.

| Item | Doc | Notes |
|---|---|---|
| Scan ETA: switch from bytes/sec to files/sec + inode count | `open-questions.md` | `bytesProcessed` is the sum of stat'd file sizes, not bytes read — a single large file causes a massive rate spike. Scan time is uniform per-inode (stat cost), so `filesPerSec` against `df -i` inode count is a much more stable ETA. Also consider widening the 5s rolling window or using an EMA. |
| Scan snapshots / history | `open-questions.md` | Version `files` table per `scan_job_id` so users can browse previous scan states and compare scans over time. Currently `files` is overwritten on each scan. |
| Copy job: rich insight view (match scan job pattern) | | Same philosophy as scan jobs — show a rich view of all available job insights in both the diff view (where the copy is initiated) and the job details page. Reuse the same component. |

Recently completed backlog:

- macOS metadata noise (`.DS_Store`, `._*`) and Waypoint disk identity files (`.waypoint-disk-id`) are globally excluded from scans, diffs, duplicate detection, and copy jobs.
- Tree view syncs the current folder path with the URL and browser history.
- Copy job status on the diff view links to the job details page.
- Copy job progress shows pending files/bytes, ETA, and per-file byte progress for large files.

---

## Key things to keep in mind

- **The tool never deletes user files.** All cleanups move to `.waypoint-quarantine/`. User deletes from quarantine themselves via Finder.
- **All write/move/rename operations check existence first** and are tested to assert no-overwrite. Code-level invariant.
- **All errors are logged per-file in SQLite** — nothing silent, everything retryable.
- **Permission errors during scans are non-fatal** (logged, indexing continues).
- **Scans index everything**; exclusion patterns apply only at copy time.
- **Resume robustness**: copy logic always re-checks per-file state at the destination on encounter (does it exist? hash match?). Don't trust the persisted plan blindly.
- The project is named **Waypoint**. GitHub: github.com/gaelollivier/waypoint.
