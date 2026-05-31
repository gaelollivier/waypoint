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

**Test suite**: `bun test` in `apps/api/` — 393 tests across 27 files. Pre-commit hook runs `tsc --noEmit` (web) + `bun test` (API) on every commit.

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
| fullHash scan freezes the web UI | During a long fullHash scan on an HDD, the web app becomes unresponsive — job-status fetches and other API calls appear to hang. Likely cause: scan worker holding the SQLite write lock and/or starving the HTTP event loop during large sequential reads. Investigate whether the scan worker can yield more aggressively, reduce DB write batch size, or move into a separate Bun worker with its own SQLite connection (same pattern as the speed-test jobs and the duplicate-detection backlog item above). |
| Perceptual / content fingerprinting for re-encoded duplicates | Byte-identical dedup is exhausted on at least one large tree, but visually-identical re-encoded copies (e.g. Google's storage-saver pass, Drive thumbnails, transcoded videos) remain undetected. Two-layer design sketch: (a) image pHash/dHash via a new opportunistic job that adds a `perceptual_hash` column to `files`, computed lazily on photo/video extensions; (b) for videos, a fast pre-filter on duration + dimensions + codec from mediainfo, with frame-sampled pHash and optionally chromaprint audio fingerprint as confirmation. Detector produces advisory suggestion rows; **never auto-applied** — pHash alone isn't safe (burst-mode shots collide). Require a second signal (EXIF DateTimeOriginal, sidecar timestamp, size band) before surfacing as a cleanup proposal. The pairwise comparison UI (`/compare`) is the ground-truth surface for tuning these thresholds: agent emits candidate pairs into a batch, user verdicts each as same / different / unsure, agent reads verdicts back before deciding what to auto-propose. |

Recently completed backlog:

- Encoding comparison backend MVP: new `encoding_sample_sets`,
  `encoding_samples`, `encoding_variants`, and `encoding_frames` tables
  support a small video re-encoding experiment loop. The API can register
  source samples + variant matrices, run ffmpeg encodes into a guarded
  scratch root, extract evenly-spaced JPEG frames from source clips and
  completed variants, list frame rows, create blinded frame-comparison
  batches, render those batches in `/compare`, aggregate verdict rankings,
  and clean generated scratch artifacts through the disk-write gateway.
  The next remaining piece is a small rankings UI on the sample-set detail
  view.

- Media metadata extraction job: new `media_metadata` table + `media_metadata_extraction` job type. Worker thread per chunk extracts EXIF (via `exifr`) for image extensions and QuickTime/MP4 container tags (via `ffprobe`) for video, normalising to `{datetime_original, datetime_source, captured_at_unix, make, model}`. Datetime priority for video: `com.apple.quicktime.creationdate` → `date` → `creation_time`. Idempotent — skips files that already have a row. `POST /api/disks/:id/media-metadata { scanId?, pathPrefix? }` kicks it off; one job per disk at a time. Reads go through the disk-reads gateway. Tests cover the pure parsers (15) and the worker-driven job loop (4). No UI yet — first consumer is the duplicate-detection agent layering on basename+EXIF+camera matching.

- Pairwise media comparison batches: new `/compare` list + `/compare/:batchId` side-by-side viewer backed by `comparison_batches` / `comparison_members` and a streaming `/api/media?path=…` endpoint with HTTP Range support (so the browser's `<video>` element can seek). The agent posts batches of candidate non-byte-identical pairs to `POST /api/comparisons`; the user verdicts each pair as same / different / unsure with optional notes. Streaming endpoint normalises the requested path and refuses anything outside a registered disk mount. Verdicts are advisory ground truth for the perceptual-fingerprinting work tracked above. See `AGENTS.md → Pairwise comparison batches`.

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
