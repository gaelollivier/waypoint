# Schema (v1 sketch)

This is the working schema for Waypoint v1. Not yet locked — fields and indices will be refined as implementation begins. SQLite throughout, WAL mode, host DB only.

---

## Core entities

### `disks`
Physical disks the user has registered with the tool.

| Field | Notes |
|---|---|
| `id` | Internal autoincrement |
| `disk_uuid` | UUID written to `.waypoint-disk-id` on the disk; stable identity across reconnects |
| `label` | User-friendly name ("HDD-A", "Photos SSD") |
| `kind` | `ssd` / `hdd` — auto-detected via `diskutil info` at registration; drives concurrency tuning |
| `capacity_bytes` / `free_bytes` | From last connection |
| `mount_path` | Last-known mount point. Nullable when offline. |
| `is_connected` | Derived/cached |
| `last_seen_at` | Timestamp |
| `last_scan_job_id` / `last_scan_at` | Denormalized cache for the disks list/details UI |
| `last_backup_job_id` / `last_backup_at` | Same — fastest path for "when did I last back this up?" |
| `last_verify_job_id` / `last_verify_at` | Same |

These `last_*` fields are updated on job completion. The full history lives in `jobs` (queried via the top-level `source_disk_id` / `dest_disk_id` / `target_disk_id` columns).

---

### `directories`
Every directory across every disk. Carries materialized aggregates so tree views are O(1) per node.

| Field | Notes |
|---|---|
| `id` | INTEGER PK (rowid) |
| `disk_id` | FK |
| `parent_id` | FK to `directories.id`, nullable for disk root |
| `name` | Just the segment, not full path |
| `path` | Full path within the disk (denormalized for fast lookup) |
| `total_size_bytes` | Recursive sum of all descendant files (materialized) |
| `file_count` | Recursive count of all descendant files (materialized) |
| `direct_file_count` | Files directly in this dir (non-recursive) |
| `last_scan_id` | Last scan that touched this directory |
| `aggregates_computed_at` | Timestamp of last bulk-recompute |

Indices: `UNIQUE (disk_id, path)`, `(disk_id, parent_id)`.

**Why integer PK + uniqueness constraints (not composite PK):** integer rowid keys keep FKs on `files` small (8 bytes vs ~80+ bytes for `(disk_id, path)` composites), which matters at millions of rows. SQLite's `INTEGER PRIMARY KEY` becomes the rowid for fastest lookups.

---

### `files`
Every file across every disk. Current state only — no history. Re-scans update in place.

| Field | Notes |
|---|---|
| `id` | INTEGER PK (rowid) |
| `disk_id` | FK |
| `directory_id` | FK to `directories.id` |
| `name` | Filename only |
| `path` | Full path within the disk (denormalized for fast lookup by path) |
| `size_bytes` | |
| `mtime` | Modification time from filesystem |
| `sampled_hash` | BLAKE3 of size + sampled bytes (or full content for files ≤ 100KB). Primary change-detection identity. |
| `full_hash` | BLAKE3 of full file content. Nullable. Populated by copy jobs and opt-in `fullHash` scans; carried forward only across later plain scans when the sampled hash still matches. FullHash scans always recompute it from disk. |
| `hash_algo_version` | Bumped if sampling layout or algo changes — allows lazy re-hash on mismatch |
| `last_scan_id` | Last scan that confirmed this file |
| `last_verified_at` | Legacy placeholder from the earlier dedicated verify-job design. |

Indices: `UNIQUE (disk_id, directory_id, name)`, `UNIQUE (disk_id, path)`, `(sampled_hash)` for cross-disk lookup / diff joins, `(disk_id, last_scan_id)` for "files not seen in latest scan."

**No `status` / `error_detail` on `files`.** Operational state lives in the per-job items tables (`copy_items`, `verify_items`). `files` is the steady-state index, not an operations log.

---

## Job machinery

### `jobs`
One row per job, primitive or composite. Polymorphic via `type`.

| Field | Notes |
|---|---|
| `id` | INTEGER PK |
| `type` | `scan` / `diff` / `copy` / `verify` / `duplicate_detection` / `directory_duplicate_cleanup` / `write_speed_test` / `read_speed_test` / `media_metadata_extraction` / `encoding_sample_run` / `encoding_frame_extract` / `backup` (composite) |
| `parent_job_id` | Set on sub-jobs of a composite. Nullable. |
| `status` | `queued` / `running` / `paused` / `completed` / `failed` / `cancelled` |
| `phase` | For composite jobs: `scanning_source` / `scanning_dest` / `diffing` / `copying` / `done`. NULL for primitives. |
| `active_sub_job_id` | Composite's currently-active child |
| `source_disk_id` | Top-level disk reference for indexed lookup. Nullable for jobs without a source (e.g. verify). |
| `dest_disk_id` | Top-level disk reference for indexed lookup. Nullable. |
| `target_disk_id` | The single disk a primitive job operates on (scan, verify, duplicate detection, write speed test). Nullable. |
| `payload_json` | Type-specific extra input (file sets, options, etc.). The common disk fields are promoted to top-level columns above so most filters never touch JSON. |
| `progress_json` | Live metrics (files/sec, MB/sec, ETA) |
| `bytes_processed` / `items_processed` | Aggregate counters |
| `warnings_count` / `non_critical_errors_count` / `errors_count` | |
| `started_at` / `updated_at` / `completed_at` | |
| `created_by` | `user` / `composite` |

Indices: `(type, status)`, `(target_disk_id, type, completed_at DESC)`, `(source_disk_id, type, completed_at DESC)`, `(dest_disk_id, type, completed_at DESC)`, `(parent_job_id)`. JSON queries are still possible via `payload_json` but should never be the hot path — top-level disk columns + indices keep filtered scans on tiny sets.

---

### `scan_walk_queue`
The persisted walk queue for resumable scanning. One row per directory the scan still needs to process.

| Field | Notes |
|---|---|
| `id` | PK |
| `scan_job_id` | FK |
| `disk_id` | FK |
| `path` | Directory path to process |
| `parent_directory_id` | FK to `directories` once the parent has been processed |
| `status` | `pending` / `in_progress` / `done` / `error` |
| `enqueued_at` | |
| `started_at` / `completed_at` | |
| `error_detail` | |

Indices: `(scan_job_id, status)` for fast "next pending dir" pop.

Rows can be deleted on scan completion (or kept for debugging). One transaction per directory: enumerate entries → insert file/subdir rows → mark dir done.

---

### `duplicate_groups`
Per-file duplicate groups emitted by a duplicate-detection job. The job payload records the selected `scanId`, and the group records which hash evidence was used for that scan snapshot.

| Field | Notes |
|---|---|
| `id` | PK |
| `duplicate_job_id` | FK to `jobs.id` |
| `hash_kind` | `full` when grouped by persisted `full_hash`; otherwise `sampled` |
| `content_hash` | The actual hash used to form the group (`full_hash` preferred, sampled fallback) |
| `sampled_hash` | Sampled hash retained for display / freshness rechecks |
| `file_count` | Number of copies in the group |
| `size_bytes` | Per-file size |
| `wasted_bytes` | `size_bytes * (file_count - 1)` |

Only `hash_kind = 'full'` groups are eligible for destructive cleanup. Cleanup still recomputes fresh sampled hashes for the kept file and every file to delete before unlinking.

---

### `copy_items`
Per-file copy state for an active copy job. Lets the copy job resume mid-stream and surface per-file errors.

| Field | Notes |
|---|---|
| `id` | PK |
| `copy_job_id` | FK to `jobs` |
| `source_file_id` | FK to `files` |
| `dest_disk_id` | FK to `disks` |
| `dest_path` | Path the file will/did land at on dest |
| `status` | `pending` / `in_progress` / `done` / `error_hash_mismatch` / `error_io` / `skipped_already_present` / `skipped_source_changed` |
| `bytes_copied` | For mid-file resume reporting (not used for actual resume — we restart the file) |
| `started_at` / `completed_at` | |
| `error_detail` | |
| `temp_filename` | Name of the `.backup-tmp-<uuid>` file, for orphan tracking |

Indices: `(copy_job_id, status)`.

---

### `job_events`
Per-job event log. Powers the "raw events" tab and stores structured records (exclusions, errors, phase changes) the UI needs to render.

| Field | Notes |
|---|---|
| `id` | PK |
| `job_id` | FK |
| `timestamp` | |
| `level` | `info` / `warning` / `error` |
| `category` | `excluded` / `error` / `phase_change` / `progress_milestone` / etc. |
| `message` | Human-readable |
| `payload_json` | Structured (path, pattern, hash, etc.) |

Indices: `(job_id, timestamp)`, `(job_id, category)`.

**Logging granularity for excludes:** log at the granularity of the *match*, not every file underneath an excluded directory. One excluded `node_modules` directory = one event, not 100K.

---

### `diff_entries`
Per-file diff results for a diff job. The diff job row in `jobs` (`type='diff'`) carries `source_disk_id`, `dest_disk_id`, and the source/dest scan job ids in `payload_json`. "Latest valid diff" for a source↔dest pair = most recent completed diff job for those two disks.

| Field | Notes |
|---|---|
| `id` | PK |
| `diff_job_id` | FK to `jobs.id` |
| `source_file_id` | FK to `files.id`. Nullable for `removed` entries (file only exists on dest). |
| `dest_file_id` | FK to `files.id`. Nullable for `added` entries (file only exists on source). |
| `kind` | `added` / `removed` / `changed` / `present` |
| `path` | Source path normally; dest path for `removed` entries. Always populated. |
| `size_bytes` | Source size normally; dest size for `removed` entries. |

Indices: `(diff_job_id, kind)`, `(diff_job_id, path)`.

`present` entries ARE stored — the copy job needs to know exactly which files to skip, and the diff UI shows present counts at every directory level.

---

### `diff_dirs`
Materialized directory aggregates for a diff job. Same O(files + dirs) bottom-up rollup algorithm as `recomputeAggregates` in the scan job — do NOT use correlated LIKE subqueries (see `open-questions.md` → recomputeAggregates freeze).

Algorithm:
1. `SELECT parent_path, kind, COUNT(*), SUM(size_bytes) FROM diff_entries GROUP BY parent_path, kind` for direct-child totals per directory.
2. Load `(id, parent_id)` for all dirs; sort deepest-first; accumulate into parents in JS.
3. Write back in one transaction, yielding every 500 rows.

| Field | Notes |
|---|---|
| `id` | PK |
| `diff_job_id` | FK to `jobs.id` |
| `parent_id` | FK to `diff_dirs.id`. Nullable for root. |
| `path` | Full directory path |
| `added_count` / `added_bytes` | |
| `changed_count` / `changed_bytes` | |
| `removed_count` / `removed_bytes` | |
| `present_count` / `present_bytes` | |

Indices: `UNIQUE (diff_job_id, path)`, `(diff_job_id, parent_id)`.

**API shape** (`GET /api/disks/:id/diff?destDiskId=X&parentPath=Y`): returns the `diff_dirs` children + `diff_entries` file rows for a given directory level — mirrors the tree API exactly. Frontend `DiffExplorer` component consumes this.

---

### `verify_items`
Per-file verify state. Same shape as `copy_items` but simpler.

| Field | Notes |
|---|---|
| `id` | PK |
| `verify_job_id` | FK |
| `file_id` | FK |
| `status` | `pending` / `in_progress` / `verified` / `mismatch` / `read_error` |
| `recomputed_hash` | Set on completion |
| `completed_at` | |
| `error_detail` | |

---

## Encoding comparison

These tables support the media re-encoding experiment workflow: register
a small set of representative source clips, encode a variant matrix into
a guarded scratch root, extract still frames, then present blinded
comparisons through the comparison UI.

### `encoding_sample_sets`
One encoding experiment. The `scratch_root` is the only filesystem root
where generated encoder outputs and extracted frames for this set may be
written or deleted.

| Field | Notes |
|---|---|
| `id` | PK |
| `name` | User-visible experiment name |
| `notes` | Optional notes |
| `scratch_root` | Absolute scratch directory root for generated artifacts |
| `status` | `pending` / `encoding` / `ready` / `archived` |
| `created_at` | Timestamp |

### `encoding_samples`
One source clip registered into an experiment. Source metadata is cached
at registration time so the UI can still render experiment context after
later scans.

| Field | Notes |
|---|---|
| `id` | PK |
| `set_id` | FK to `encoding_sample_sets.id` |
| `position` | Stable order within the set |
| `source_disk_id` | FK to the registered disk holding the source clip |
| `source_path` | Absolute source media path |
| `source_file_id` | FK to the latest scanned file row at registration time |
| `clip_start_seconds` / `clip_duration_seconds` | Optional window to encode/sample |
| `label` | Optional display label |
| `source_size_bytes` | Cached source size |
| `source_duration_seconds` | Cached source duration from media metadata |
| `source_make` / `source_model` | Cached camera metadata |
| `source_captured_at_unix` | Cached capture timestamp |

Index: `(set_id, position)`.

### `encoding_variants`
One encoder setting applied to one sample. The encoder job fills in the
output fields as each ffmpeg subprocess completes.

| Field | Notes |
|---|---|
| `id` | PK |
| `sample_id` | FK to `encoding_samples.id` |
| `position` | Stable order within the sample |
| `codec` | Logical codec family, e.g. `hevc`, `av1`, `h264`, `reference` |
| `encoder` | ffmpeg encoder, e.g. `libx265`, `hevc_videotoolbox`, `libsvtav1`, `copy` |
| `preset` | Encoder-specific preset, nullable |
| `crf` | Encoder-specific quality value, nullable |
| `extra_args_json` | JSON array of additional ffmpeg args |
| `label` | Optional display label |
| `output_path` | Generated variant file path under `scratch_root` |
| `output_size_bytes` | Generated file size |
| `encode_seconds` | Wall-clock encode time |
| `status` | `pending` / `running` / `done` / `failed` / `skipped` |
| `error_detail` | Captured failure detail |
| `started_at` / `completed_at` | Timestamps |

Indices: `(sample_id, position)`, `(status)`.

### `encoding_frames`
Extracted JPEG frames for either a source sample or an encoded variant.
Exactly one of `sample_id` or `variant_id` is set. Rows are pre-created
idempotently by the frame-extraction job, then filled with an `output_path`
after ffmpeg writes the JPEG.

| Field | Notes |
|---|---|
| `id` | PK |
| `sample_id` | FK to `encoding_samples.id`, set for source frames |
| `variant_id` | FK to `encoding_variants.id`, set for variant frames |
| `position` | 0-based frame index |
| `at_seconds` | Absolute timestamp in the source/variant timeline |
| `output_path` | Generated JPEG path under `scratch_root` |
| `status` | `pending` / `running` / `done` / `failed` |
| `error_detail` | Captured failure detail |
| `started_at` / `completed_at` | Timestamps |

Indices: unique `(sample_id, position)` where `sample_id IS NOT NULL`,
unique `(variant_id, position)` where `variant_id IS NOT NULL`, and
`(status)`.

### Encoding comparison fields on `comparison_*`

`comparison_batches.kind` is `dedup` for normal duplicate-review batches
and may be `encoding_frames` or `encoding_video` for encoding comparison.
Encoding batches may set `sample_id` to the source sample being compared.

`comparison_members.left_variant_id` and `right_variant_id` optionally
refer to `encoding_variants`. The existing path fields remain the
renderable media/frame paths.

`comparison_members.verdict` accepts both the original dedup verdicts
(`same`, `different`, `unsure`) and encoder-preference verdicts
(`prefer_left`, `prefer_right`, `tie`). The API enforces which subset is
valid for each batch kind.

`GET /api/encoding-sample-sets/:id/rankings` reads only
`comparison_batches.kind = 'encoding_frames'` rows for the set's samples and
scores variant ids without returning source paths, output paths, or scratch
roots. `prefer_*` verdicts count as 1 point for the chosen variant; `tie`
counts as 0.5 for both variants.

---

## Config

### `disk_excludes`
Per-disk glob patterns. **Applied only at copy time** — scans index everything regardless. Edited from UI before running a backup.

| Field | Notes |
|---|---|
| `id` | PK |
| `disk_id` | FK to source disk (excludes are defined per source) |
| `pattern` | Glob string (e.g. `node_modules`, `.DS_Store`) |
| `is_default` | True for system-shipped patterns; user can disable but not delete |
| `enabled` | Boolean |

---

### `excluded_paths`
Per-disk path exclusions for **duplicate detection only**. Files at or under any row here are filtered out of both the Phase 1 GROUP BY and the per-group member lookups in `duplicate-job.ts`. Scan, diff, and copy are unaffected — the file is still indexed and still copied; it just never surfaces as a duplicate-detection candidate. CRUD is exposed via `GET / POST / DELETE /api/disks/:id/excluded-paths`. UI lives in the Notes tab section and the "Exclude folder…" button on each duplicate-group card.

| Field | Notes |
|---|---|
| `id` | PK |
| `disk_id` | FK to `disks.id` (ON DELETE CASCADE) |
| `path` | Absolute path, stored without trailing slash. Matches `files.path = e.path OR files.path LIKE e.path \|\| '/%'`. |
| `reason` | Optional free-text note from the user |
| `created_at` | Timestamp |

Indices: `UNIQUE (disk_id, path)`. SQL fragment used by detection: `lib/excluded-paths.ts` exports `EXCLUDED_PATHS_SQL` (a `NOT EXISTS` correlated subquery), which keeps the surrounding query sargable on the partial hash indexes.

---

### `disk_locks`
Mirrors the in-memory write-lock state to the DB so the UI can render lock status and stale locks can be cleared on startup.

| Field | Notes |
|---|---|
| `disk_id` | PK |
| `held_by_job_id` | The job currently holding the write lock |
| `state` | `active` / `paused` |
| `acquired_at` | Timestamp |
| `paused_at` | Nullable |

On startup: any `disk_locks` row whose `held_by_job_id` is in a terminal status (completed/failed/cancelled) gets dropped.

---

### `quarantine_items`
Legacy table from the earlier quarantine-based cleanup design. The current safety philosophy has moved toward narrow guarded deletion flows instead: duplicate cleanup is browser-confirmed and requires a kept identical copy, while future Waypoint temp-file cleanup should delete only explicitly reviewed paths that match allowed tool-generated filename patterns. This table still exists in the schema today but is not the target model for future cleanup work.

| Field | Notes |
|---|---|
| `id` | PK |
| `disk_id` | FK |
| `original_path` | Where the file was before moving |
| `quarantine_path` | Where it now lives within `.waypoint-quarantine/` |
| `reason` | `orphan_temp` / future categories |
| `source_job_id` | FK to the job that created the orphan, if known. Nullable. |
| `moved_by_job_id` | FK to the job that performed the move (a user-triggered cleanup action). |
| `moved_at` | Timestamp |
| `size_bytes` | For UI display |

Indices: `(disk_id, moved_at DESC)`.

---

### `meta`
Key-value store for tool-wide config (schema version, settings).

| Field | Notes |
|---|---|
| `key` | PK |
| `value` | Text |

`PRAGMA user_version` also tracks schema version for migrations (fit pattern).

---

## Performance notes

- **Batched DB writes during scan/copy/verify.** Files are processed in batches of ~500-1000 inside one SQLite transaction. Per-row write cost becomes negligible. No "fast mode" code path needed (every file always carries a `*_items` row).
- **`*_items` tables are per-job and bounded.** Once a job completes, its items can be archived/dropped if storage matters. Default retention TBD.

## What's intentionally absent

- **No "fast mode" copy path.** Every file gets a `copy_items` row. Batched transactions absorb the overhead. Bifurcating the copy path into "tracked" and "untracked" was considered and rejected — too much code duplication, hides errors in the small-file path which is exactly where we most need the audit trail.
- **No file version history.** `files` holds current state only. The git log of "what changed when" is captured by `last_scan_id` and per-job event logs, not full versioning.
- **No closure table.** Aggregates are materialized on `directories` instead. Recursive-CTE-style ad-hoc subtree queries are not a target — if needed later, build a closure table on top of this.
- **No on-disk sidecars.** Host DB only in v1.
- **No `backups` table separate from `jobs`.** A "backup" is a composite job; its history lives in the `jobs` table with `type='backup'`. The `disks.last_backup_*` denormalized fields plus `jobs.source_disk_id` / `dest_disk_id` / `target_disk_id` indices cover all common queries without scanning `payload_json`.
- **No `disk_jobs` junction table.** Considered and rejected — the top-level disk FKs on `jobs` (with indices on each) make the junction redundant at our scale.
