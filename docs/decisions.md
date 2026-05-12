# Design Decisions

Settled decisions from the research phase. These are not up for re-discussion unless new information changes the calculus. Open questions live in `open-questions.md`.

---

## Safety constraints (hard, non-negotiable)

- **Additive-only writes.** The backup copy job only ever creates new files. It never overwrites, renames, or deletes files at the destination.
- **Zero deletion code in the codebase.** Not in the copy job, not in the diff view, not in cleanup actions, not anywhere. The tool never calls `unlink`/`rm`/equivalent on user files. The user does all final deletions themselves via Finder.
- **Move-to-quarantine instead of delete.** When the tool needs to "clean up" something (orphan temp files, etc.), it MOVES the file to a quarantine directory on the same disk (`.waypoint-quarantine/` at the disk root). User reviews and deletes from quarantine themselves. Quarantine moves never overwrite — collisions get a uuid suffix.
- **No sync semantics.** Files removed from the source are never removed from the destination. The backup is a one-way accumulation.
- **If a file already exists at the destination:** hash it and compare to the source hash. If they match → skip, log as `already_present_verified`. If they don't match → error, log, surface for manual review. Never overwrite.
- **Orphaned temp files** (from interrupted copies) are detected and logged. Cleanup is a user-triggered action that MOVES them to quarantine, never deletes.
- **Scanning is read-only.** No writes to source or destination during scan/inspect operations, except to the SQLite metadata DB on the host.
- **All write/move/rename operations are gated by an existence check** at the call site (target path must not exist) and are covered by tests that assert no-overwrite. This is enforced as a code-level invariant, not just convention.

## Error handling

- All errors are logged per-file in SQLite with a status field and error detail text. Nothing is silent.
- The UI prominently surfaces an error/review count after any job.
- Errored files are individually retryable from the UI without re-running the full job.
- Non-fatal errors (e.g. permission denied on a single directory, iCloud-dataless skip) are tracked separately from fatal errors that abort a file.

## Scale baseline (source SSD)

Measured on the source SSD (photo/video-heavy personal library):

- ~177K files, ~3,800 directories
- ~3.5 TiB used
- File size profile: bulk in 1-10MB range (~104K files), ~500 files ≥1GB, ~22K files <100KB
- Average file ~20MB; video/photo-heavy

**Implication for schema:** all sizing is comfortable for SQLite. ~180K rows × ~5 disks × a few scans worth of state = well under 10M rows total. Standard B-tree indices, no partitioning, no JSONB tricks needed.

**Implication for hashing:** size profile favors sampled hashing strongly. Most bytes live in files large enough for sampling to pay off; tiny files cross the 100KB threshold and get full-hashed anyway.

**Implication for performance:** the SSD scan is fast in absolute terms (~minutes). The HDD copy throughput is the real bottleneck (3.5TB ÷ 150 MB/s ≈ 7 hours minimum, ignoring per-file overhead).

---

## Storage format

- **SQLite with WAL mode** for everything: file index, scan state, job queue, history. `synchronous=NORMAL` minimum; `synchronous=FULL` for job state table if warranted.
- **Never `synchronous=OFF`** (gdu's approach — crash-unsafe).
- **Plain file copies** on the HDD in their original directory structure. No content-addressed format, no encryption, no dedup. Files on the HDD are independently usable without this tool.
- **Self-describing disk**: a dotfile (`.waypoint-disk-id`) with a UUID written on first use. Used to identify the disk across reconnects. Same pattern as Spacedrive's `SPACEDRIVE_VOLUME_ID_FILE`.
- **State topology (v1): host DB only.** All file indexes, job state, history, and disk metadata live in a single SQLite DB on the host. No on-disk sidecar. If the host DB is lost, indexes must be rebuilt by re-scanning each disk. Sidecar DBs on the disks are deferred to a later version.

## Hashing

- **BLAKE3** everywhere. Not SHA-256 (slower), not xxHash (not cryptographic enough for integrity verification).
- **Two hashes per file** (both BLAKE3, stored on the `files` row):
  - `sampled_hash` — primary identity for change detection. Always populated.
  - `full_hash` — opportunistic, computed for free during copy. Nullable. Used by future "full verify" mode.
- **Sampled hash definition** (Spacedrive's pattern):
  - Files ≤ 100KB: full hash (no useful sampling for tiny files).
  - Files > 100KB: BLAKE3 over `(size as 8 bytes) || header[0..8KB] || sample₁[10KB] || sample₂[10KB] || sample₃[10KB] || sample₄[10KB] || footer[last 8KB]`. Sample positions evenly spaced through the interior. Size prefix prevents collisions across files of different sizes with identical sampled bytes.

### Per-job hashing behavior

- **Initial scan**: compute `sampled_hash` for every file. Do not compute `full_hash`.
- **Re-scan**: filter by mtime+size first (free, from `stat()`); only re-compute `sampled_hash` if mtime or size changed, or if the file is newly discovered. Files unchanged on filesystem are not re-read.
- **Copy job**: compute `full_hash` inline during the sequential read pass (every byte flows through the BLAKE3 hasher — free). Store `full_hash` on both the source and destination `files` rows. Source is re-validated before copy (re-stat + re-compute sampled hash); if source changed since scan, the file is skipped. No post-write hash verification — the verify job is the authoritative on-disk correctness check.
- **Verify job (default = sampled mode)**: re-compute `sampled_hash` from disk, compare to stored `sampled_hash`. Catches change in the sampled regions; does NOT detect bit rot in unsampled regions of large files.
- **Verify job (full mode, future v1.x)**: re-compute `full_hash` from disk, compare to stored `full_hash`. The "true scrub." Skipped if `full_hash` is null on a file (file was never copied through this tool, only scanned).

### Risk acknowledgment for sampled verify

For large files (e.g. 100GB videos), sampled hashing covers ~58KB out of ~10⁸KB = 0.00006% of the file. Bit rot in the unsampled 99.99% is undetected by default verify. This is a known tradeoff:

- Step up from current state (rsync-only, zero integrity): meaningful improvement.
- Step down from a full-verify backup tool: real coverage gap.
- Mitigation path: the future "full verify" mode is the answer for periodic deep scrubs. Sampled verify is the cheap continuous check.

Acceptable for v1 given the user's hardware (slow HDD where full verify is hours-long) and current baseline.

## Atomic writes

- **Temp→rename pattern** for all file copies: write to `filename.backup-tmp-<uuid>` in the same directory, then rename to final name on completion.
- Rename is atomic on POSIX — no reader ever sees a partial file.
- **Why temp→rename instead of writing directly to the final path:**
  - The HDD is meant to be browsable as a normal filesystem — Finder/Spotlight should never see partial files at canonical paths.
  - Encodes intent in the path: `*.backup-tmp-*` = "we crashed during this write" vs canonical-path hash mismatch = "previously-good file corrupted." Different recovery semantics.
  - Concurrent retries can't collide on the same canonical path.
  - Cost is one rename per file (a single inode op, free on the same filesystem).
- **No per-file fsync.** Per-file fsync on a 5400rpm HDD destroys throughput. Crash safety relies on (a) the temp→rename pattern preventing partial files at canonical paths, (b) the verify job as the true correctness guarantee that bytes are durably on disk. The verify job is the authoritative check, not the copy job.
- **Inline hashing during copy**: BLAKE3 hasher accumulates incrementally as bytes are read from source and written to destination temp file. Produces `full_hash` for free from the sequential read. Single read pass, no post-write re-hash. Rename always proceeds after write completes — the verify job is the authoritative integrity check.

## Architecture

- **Client/server**: TypeScript/Bun daemon + JSON over HTTP + web UI. Single binary. Bound to localhost, no auth.
- **Language**: TypeScript with Bun. Chosen over Go/Rust (user knows TS best; HDD is the bottleneck, not the runtime) and over Node.js (bun:sqlite built-in, same npm compatibility for web-focused packages, marginally faster fs ops).
- **HTTP framework**: Hono — lightweight, native Bun support, good SSE primitives.
- **Frontend**: React, built with Vite. Vite dev server in development; built static assets served from the Bun binary in production.
- **SQLite**: `bun:sqlite` (built-in, no native addon required).
- **Web UI**: server-sent events (SSE) for live job progress. Thin client, JSON API.
- **Realtime**: SSE only. No WebSockets — progress is unidirectional, browser auto-reconnect handles HDD plug glitches / sleep / wake.
- **Drive connect/disconnect detection (macOS)**: polling `df` / volume mount points on a low-frequency interval. DiskArbitration framework via FFI is out of scope for v1.
- **No CLI as primary interface.** A small diagnostic CLI is acceptable; the web UI is the product.

## Concurrency / locking

- **Operations are categorized by what they modify on the disk itself**, not by what they read.
  - **Writers** (modify disk contents): `copy`, quarantine moves.
  - **Readers** (only read disk; any state changes go to the host DB): `scan`, `verify`, diff queries, tree browsing.
- **Write lock per disk.** Held by the active writer for that disk. Blocks all other operations on that disk while active.
- **Paused write lock** allows readers to run on the same disk. Blocks other writers. Resume re-acquires the exclusive write lock.
- **No "read lock" type.** Multiple readers can always coexist with each other and with a paused writer.
- **Application-level uniqueness per op type per disk.** Independent of the lock: only one `scan` (or `verify`, etc.) can be active or paused on a given disk at a time. Prevents two scans racing on the same `files` rows.
- **Composite job lock acquisition:** a `backup` composite acquires the write lock on the destination disk for the duration of its copy phase. Source disk does NOT need a write lock during copy (the copy reads it as a stable snapshot of `files`).
- **Resume robustness:** because pausing allows readers and any disk can theoretically change while a job is paused (reboot, unplug, reconnect, manual file ops), resume logic always re-checks file state at the destination per-file (does it exist? hash match?) rather than trusting the persisted plan blindly.
- **Lock state is mirrored to the DB** (`disk_locks` table) so the UI can show which disk is busy with which job, and so stale locks (held by jobs no longer running) can be released on startup.

## Jobs

- Every long-running operation is a **job** with durable state in SQLite.
- Primitive job types: `scan`, `diff`, `copy`, `verify`. (`diff` is a job despite being fast — keeps the model consistent, gives it a status, and its output tables (`diff_entries`, `diff_dirs`) are keyed by `diff_job_id`.)
- Composite job type: `backup` — orchestrates `scan(source) → scan(dest) → diff → copy(missing/changed)`. Sequential phases. Verify is NOT auto-chained (too slow to bundle).
- **Composite jobs are themselves stateful.** A `backup` job has its own row tracking current phase + reference to the active sub-job. Pause on the composite freezes the whole pipeline at its current point (sub-job pauses, composite remains in its current phase). User can unplug the disk or reboot mid-backup; on resume, the composite continues from the same sub-job + same point within it.
- Job statuses: `queued → running → paused / completed / failed / cancelled`.
- All jobs (primitive and composite) are pausable and resumable. Crash mid-job is treated the same as pause.
- Resume MUST do minimal redo work. Scans resume from the persisted walk queue (not from root). Copies resume from the per-file status (skip already-done, retry in-progress, continue queued).
- "Restart from scratch" is an explicit user action, not the default.
- Job metrics tracked: `bytes_processed`, `items_processed`, `warnings_count`, `non_critical_errors_count`.
- Jobs report progress (files/sec, MB/sec, ETA) via SSE.
- Job concurrency follows the lock model in the previous section (write lock per disk, paused write lock allows readers, app-level uniqueness per op type per disk).

## UI requirements that drive schema

- **Tree views with aggregated sizes.** Every directory node displays its total recursive size (sum of all descendant files). Must be fast at any scale — no recursive CTE on every UI render.
- **Diff view is a tree.** A backup pre-flight shows the user the tree of files about to be copied (not a flat list), with per-directory aggregates of "X files, Y GB to copy under this folder."
- **Materialized aggregates on `directories` table.** Each directory row stores `total_size`, `file_count`, etc. Reads are O(1) per directory.
- **Aggregate update strategy: bulk recompute, not incremental bubble-up.** Aggregates are recomputed once at the end of each scan job (and will be after copy jobs that change the dest disk's contents). Implemented in `walker.ts::recomputeAggregates`: one `GROUP BY directory_id` on `files` for direct totals, one in-memory bottom-up roll-up over the directory tree (deepest-first, summing children into parents), then one transaction of small UPDATEs with periodic event-loop yields. O(files + dirs); ~25ms for 177K files / 3.7K dirs on the source SSD. Cheaper than per-file bubble-up during scanning, simpler code, and aggregates only need to be correct *between* jobs anyway — during a scan the index is in flux. UI shows last-known aggregates with "as of [scan time]" semantics. **Avoid the temptation to do this in pure SQL with correlated `LIKE 'path/%'` subqueries**: it's quadratic in files × dirs and froze the API for ~3 minutes on the real dataset (see `open-questions.md`).

## macOS-specific behavior

- **xattrs / extended attributes are NOT preserved.** v1 explicitly does not copy `com.apple.FinderInfo` (color tags, custom icons), `com.apple.ResourceFork` (legacy Mac files), `com.apple.quarantine`, or any other xattr. Reasons:
  - User opted out — modern files (photos, videos, PDFs, code) don't use xattrs meaningfully; legacy resource forks and Finder color labels are deemed acceptable losses.
  - Bun has no native xattr stdlib; FFI to libc would add complexity for a feature we don't need.
  - Keeps the code simpler and the on-disk format truly "plain files."
- **iCloud dataless files** (`SF_DATALESS` flag) MUST be detected before scanning/hashing. Reading them triggers an iCloud download (potentially expensive, potentially fails on metered networks, definitely wrong if we hash a 0-byte stub thinking it's the file). On detection: skip the file, log as a non-critical warning. The detection requires reading `st_flags` from `stat()` and checking the `SF_DATALESS` bit (value `0x40000000` on macOS).
- **Resource forks** are not handled. They live in xattrs (`com.apple.ResourceFork`) which we don't copy.

## Excludes — scan vs copy

- **Scans index everything.** Exclusion patterns do NOT apply to scans. We want a true picture of disk usage including `.DS_Store`, `.Trashes`, `node_modules`, etc. The tree view should show the user where their disk space is actually going, including hidden/system noise.
- **Excludes apply at the copy stage only.** When a backup composite builds its copy set from the diff, exclusion patterns filter out files that should not be backed up (recreatable artifacts, system noise, dev caches).
- **Excludes are stored in a config file, not the database.** The `disk_excludes` table in the initial schema is deprecated — exclude patterns will be read from a config file instead. Simpler, version-controllable, no migration needed to change patterns.
- **Permission errors during scan are logged per directory** as non-critical errors, not failures. macOS may deny reads on `.Trashes/<other-uid>/`, restricted system dirs, etc. Index what's readable; surface what's not.
- **Cost acknowledged**: scanning + sampled-hashing a 100GB `node_modules` is wasted work if it's never copied. Acceptable for v1 — the user wants accurate disk usage. Revisit only if scan times become painful.

## Explicit non-goals (v1)

- No encryption.
- No deduplication.
- No cloud backends.
- No scheduling/cron.
- No multi-user.
- No sync semantics (source deletions are not propagated to destination).
- No restic/kopia/borg as a dependency.
