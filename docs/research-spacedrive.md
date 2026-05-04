# Research: Spacedrive

## Architecture Overview

Spacedrive (as of its v2/file-manager era) is a Rust daemon + web/desktop UI, organized as a `core` library with an `infra` layer (db, jobs, daemon, wire protocol) and a `domain` layer (content identity, volumes, files, locations). The stack is: **tokio** (async runtime), **sea-orm 1.1 + sqlx-sqlite** (ORM over SQLite), **axum** (HTTP, currently commented out in the pivot version), **blake3** for content hashing, and **specta** for type-safe API schema generation shared between Rust and TypeScript. No Prisma — they moved to sea-orm.

The pivot to v3 (AI data engine) is visible in the codebase: cloud backends, extension/WASM job system, and networking are actively under development, while the local file-manager features are complete. The architecture is significantly more complex than we need — but the core patterns (volume identity, content hashing, job system) are clean and directly applicable.

---

## Volume Identity

`domain/volume.rs` — directly confirms our design:
- External volumes get a `.spacedrive-volume-id` dotfile (constant `SPACEDRIVE_VOLUME_ID_FILE`).
- `VolumeFingerprint` is computed with BLAKE3 over the UUID from that dotfile + device ID. Three variants: `from_primary_volume` (stable mount point), `from_external_volume` (dotfile UUID), `from_network_volume` (backend URI). External removable drives use the dotfile UUID path — exactly what we planned.

**For us:** same approach, simpler implementation. Write a UUID to `.backup-tool-disk-id` on first connection, use it as the disk's identity forever. BLAKE3 fingerprint is optional; plain UUID is sufficient.

---

## Content Hashing — Sampled Hashing Pattern

`domain/content_identity.rs` — **the most important finding from this codebase:**

Spacedrive uses **sampled hashing** for large files (> 100KB): reads 8KB header + 4 × 10KB samples evenly spaced + 8KB footer = ~58KB total regardless of file size. BLAKE3 over all these chunks. For small files (≤ 100KB), full hash. The file size is hashed first (prepended to the BLAKE3 input) so files with identical sampled bytes but different sizes produce different hashes.

**Why this matters for us:** Hashing 4TB of files with BLAKE3 is fast (~6-10GB/s on modern hardware), but it still takes ~7-10 minutes. Sampled hashing would take seconds. The tradeoff: sampled hash doesn't detect corruption *within* the non-sampled regions. For a backup tool where correctness is paramount, the right policy is:
- Use **full BLAKE3** when copying (read every byte anyway — hash as we go, no extra cost).
- Use **sampled hash** for quick "has this file changed since last scan?" checks during re-scans.
- Use **full BLAKE3** for the dedicated `verify` job (re-hash the destination and compare to stored hashes).

The `ContentIdentity` model has both `content_hash` and `integrity_hash` — a two-hash design: content hash (sampled, fast, for change detection) and integrity hash (full, for verification). Worth considering for our schema.

Also notable: `last_verified_at` timestamp on `ContentIdentity`. This tracks when the stored hash was last confirmed against the actual file — exactly the kind of field we need in `backup_files` to support a `verify` job.

---

## Offline / Disconnected Volumes

`domain/volume.rs` and the volume manager track volume state (connected/disconnected). The fingerprint-based identity means a volume's indexed state persists in the DB even when disconnected. The UI shows offline volumes using cached data. This is the exact pattern described in the handoff doc — confirmed as practical.

**For us:** `disks` table has a `last_seen_at` and an `is_connected` boolean (or derived from it). All queries work against the index regardless of connection state. The scan/copy job layer checks connection before starting.

---

## Job System

`infra/job/types.rs` — the most complete job system of any tool we've reviewed:

- `JobStatus`: Queued → Running → Paused / Completed / Failed / Cancelled. `is_terminal()` and `is_active()` helpers.
- `JobSchema` has a `resumable: bool` field — job types declare their own resumability.
- `JobMetrics`: `bytes_processed`, `items_processed`, `warnings_count`, `non_critical_errors_count`, `duration_ms`. **`non_critical_errors_count` is a key field** — errors that don't abort the job but should be reviewed.
- `CheckpointHandler` interface — jobs call this to persist their in-progress state. The handler writes to the DB; the job just calls `checkpoint()` at safe points.
- Progress uses three tokio channels: `watch::Sender<JobStatus>` (current status), `mpsc::UnboundedSender<Progress>` (per-item events), `broadcast::Sender<Progress>` (fan-out to multiple subscribers — web UI, logging, etc.).
- Jobs have `parent_job_id` — supports job trees (e.g. a "backup" job spawns a "scan" sub-job and a "copy" sub-job).

**For us:** the three-channel progress model is overkill for a single-user local tool. One SSE stream per job is sufficient. The `non_critical_errors_count` field directly maps to what you described — errors that are logged, surfaced, and available for retry without aborting the whole job.

---

## Rust + SQLite Stack

- **sea-orm 1.1 + sqlx-sqlite**: ORM with async support. Adds significant complexity (code generation, active record pattern). For a simpler tool, raw `sqlx` or `rusqlite` is easier to reason about.
- **tokio**: standard choice, no surprises.
- Migrations via `sea-orm-migration` crate.
- No Prisma (they moved away from it before this snapshot).

---

## Key Takeaways

**Worth adopting:**
- Volume dotfile identity (`.backup-tool-disk-id`) — confirmed as the right pattern.
- `last_verified_at` on file records — track when each file's stored hash was last confirmed.
- Two-hash design: fast sampled hash for change detection, full hash for copy/verify operations.
- JobStatus enum with `is_terminal()` / `is_active()` — clean, copy verbatim.
- `non_critical_errors_count` + `warnings_count` in job metrics — captures "errors to review" without aborting.
- CheckpointHandler pattern: jobs don't manage their own persistence, they just call `checkpoint()` at safe points.

**What they overcomplicated (don't copy):**
- sea-orm: too much magic for our use case. Use raw sqlx or rusqlite with handwritten SQL.
- Three-channel progress system: single SSE stream is sufficient.
- Extension/WASM job registry: completely irrelevant.
- `parent_job_id` job trees: our jobs are simple enough to not need this in v1.

**Go vs Rust:**
Spacedrive's experience doesn't strongly favor one for our use case. Their complexity comes from being a distributed/cloud/multi-device system — none of which applies to us. The Rust patterns (BLAKE3, tokio, sampled hashing) are directly transferable, but the same patterns exist in Go (b3sum crate → `zeebo/blake3`, goroutines, etc.). The sampled hashing insight is language-neutral. If the developer is more comfortable in Go, Go wins on iteration speed. Rust wins on "I never want to discover a nil-pointer in my copy loop on a production backup."
