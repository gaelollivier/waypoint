# Waypoint — Start Here

Personal backup tool for cold storage drives. Mac mini, 4TB SSD → two 8TB HDDs (one connected at a time, manually rotated). Custom build — no existing tool covers all requirements.

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

**Design phase: complete.** All v1 design decisions are locked. Implementation has not started.

**Stack**: TypeScript + Bun, Hono (HTTP), React + Vite (UI), `bun:sqlite`, BLAKE3, SSE for progress.

**Scale baseline measured**: 177K files / 3.5TB on the source SSD. Standard SQLite indices are sufficient.

---

## Next session: implementation planning

The brief's section 7 sketches a milestone order; refine it for the chosen stack. Recommended order (subject to revisiting):

1. **Skeleton** — repo layout (server `apps/api`, frontend `apps/web` or similar), Bun + Hono boot, `/healthz`, dev script with Vite + API hot reload.
2. **SQLite + migrations** — `bun:sqlite` setup, WAL pragmas, migration runner using `PRAGMA user_version`. Implement the schema in `schema.md`.
3. **Disk identity & registration** — mount-point polling, `.waypoint-disk-id` dotfile, `disks` table population.
4. **Locking primitive** — in-memory R/W lock per disk, mirrored to `disk_locks`, stale-lock cleanup on startup.
5. **Job framework** — `jobs` table, status transitions, pause/resume primitives, SSE progress channel, `job_events` log.
6. **Scan job** — the keystone. Persisted walk queue, sampled BLAKE3 hashing, mtime+size shortcut on re-scan, batched DB writes (~500-1000 per tx), permission errors logged not fatal, directory aggregates recomputed at end.
7. **Web UI shell** — list disks, trigger scans, observe jobs (SSE), per-job tabs (overview / tree / excluded / errors / events).
8. **Tree view** — virtualized list backed by `directories` aggregates. Must be fast at any scale.
9. **Diff** — synchronous SQL query + `diff_cache` materialization. Tree-view rendering of the diff.
10. **Copy job** — temp→rename pattern, inline both-hashes, batched item updates, orphan-temp detection.
11. **Backup composite** — orchestrates scan → scan → diff → copy with phase tracking.
12. **Verify job** — sampled re-hash from disk.
13. **Quarantine** — orphan-temp cleanup action.
14. **Polish** — ETAs, error UX, exclude editor, retention policy for `*_items`.

The scan job (step 6) is the architectural keystone. If its resumability is wrong, everything else is wrong.

---

## Key things to keep in mind

- **The tool never deletes user files.** All cleanups move to `.waypoint-quarantine/`. User deletes from quarantine themselves via Finder.
- **All write/move/rename operations check existence first** and are tested to assert no-overwrite. Code-level invariant.
- **All errors are logged per-file in SQLite** — nothing silent, everything retryable.
- **Permission errors during scans are non-fatal** (logged, indexing continues).
- **Scans index everything**; exclusion patterns apply only at copy time.
- **Resume robustness**: copy logic always re-checks per-file state at the destination on encounter (does it exist? hash match?). Don't trust the persisted plan blindly.
- The project is named **Waypoint**. GitHub: github.com/gaelollivier/waypoint.
