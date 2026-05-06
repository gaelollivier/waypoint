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

**Implementation in progress.** Design phase complete; milestones 1–5 done.

**Stack**: TypeScript + Bun, Hono (HTTP), React + Vite (UI), `bun:sqlite`, BLAKE3, SSE for progress.

**Scale baseline measured**: ~177K files / ~3.5TB on the source SSD. Standard SQLite indices are sufficient.

**Test suite**: `bun run test` in `apps/api/` — 56 tests across 4 files.

---

## Milestone map

| # | Name | Status |
|---|---|---|
| 1 | Project skeleton (monorepo, Hono boot, Vite dev proxy, healthcheck) | ✅ Done |
| 2 | SQLite + migrations (WAL, migration runner, full schema) | ✅ Done |
| 3 | Disk identity & registration (dotfile UUID, `df` polling, disk registry API) | ✅ Done |
| 4 | Locking primitive (per-disk write lock, DB-mirrored, unit tested) | ✅ Done |
| 5 | Job framework (status machine, pause/resume/cancel, SSE progress stream) | ✅ Done |
| 6 | **Scan job** ← *next* — resumable walk queue, BLAKE3 sampled hash, batched writes | 🔲 |
| 7 | Web UI shell (disk list, job list, live SSE progress) | 🔲 |
| 8 | Tree view (virtualized disk explorer, materialized aggregates) | 🔲 |
| 9 | Diff (source vs. dest comparison, diff_cache) | 🔲 |
| 10 | Copy job (temp→rename, dual inline hashing, resume-safe) | 🔲 |
| 11 | Backup composite (scan→scan→diff→copy pipeline, pause-as-unit) | 🔲 |
| 12 | Verify job (re-hash files, surface mismatches) | 🔲 |
| 13 | Quarantine & cleanup (orphan temp files → .waypoint-quarantine/) | 🔲 |
| 14 | Polish (ETAs, exclude editor, error review UI, SMART data) | 🔲 |

The scan job (M6) is the architectural keystone — if its resumability is wrong, everything else is wrong.

---

## Key things to keep in mind

- **The tool never deletes user files.** All cleanups move to `.waypoint-quarantine/`. User deletes from quarantine themselves via Finder.
- **All write/move/rename operations check existence first** and are tested to assert no-overwrite. Code-level invariant.
- **All errors are logged per-file in SQLite** — nothing silent, everything retryable.
- **Permission errors during scans are non-fatal** (logged, indexing continues).
- **Scans index everything**; exclusion patterns apply only at copy time.
- **Resume robustness**: copy logic always re-checks per-file state at the destination on encounter (does it exist? hash match?). Don't trust the persisted plan blindly.
- The project is named **Waypoint**. GitHub: github.com/gaelollivier/waypoint.
