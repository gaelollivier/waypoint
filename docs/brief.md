# Personal Backup System — Project Handoff

This document is the full context of the design conversation that led to building this project. Read it end-to-end before writing code; it contains the requirements, the existing-tools research that justifies building custom, and the architectural conclusions reached so far. Nothing has been implemented yet.

---

## 1. Hardware and operational context

- **Host:** Desktop Mac, sitting on a desk. Everything connected via USB.
- **Source drive:** 1× large SSD, already nearly full.
- **Backup destinations:** 2× large HDDs, 5,400rpm (slow). Only one external enclosure available, so only one HDD is ever connected at a time. Space on the desk is also limited; this constraint is durable, not temporary.
- **Usage model:** Each HDD acts as an independent **cold-storage copy** of the SSD. Not a live mirror. Not a NAS (a proper NAS is a future, separate project). The user rotates HDDs manually — connect HDD-A, run a backup, disconnect; later connect HDD-B, run a backup, disconnect.
- **Implication:** The system must treat each HDD as its own backup destination with its own state, and must be able to compare state across destinations (HDD-A vs HDD-B vs SSD) even when they aren't all connected at once.

---

## 2. Requirements (in priority order)

### 2.1 Open source
- Code must be inspectable.
- Documentation must exist.
- **The metadata produced (file index, backup state, history) must be usable outside the tool itself.** This is a hard requirement — no proprietary or encrypted-only index formats. SQLite, queryable from any standard tool, is the target.

### 2.2 Resumable end-to-end (top priority alongside open source)
- Copying 4TB to a 5,400rpm HDD takes many hours and is loud. The user must be able to pause and resume cleanly.
- **Disk scanning is itself slow on the HDD** and must also be resumable. Building a file tree on the HDD is a long operation; if it's interrupted, the next run must continue, not start over.
- State to persist: file tree per disk, per-file backup status, latest backup pointer, in-flight task progress, queue contents.
- Implies a **task / queue system** with durable state.
- Storage: **SQLite** with WAL mode for everything.

### 2.3 Client/server architecture with a rich web UI
The web app doubles as the user's general disk/storage helper. Required features:
- Disk inspection: capacity, used, free; SMART data if feasible.
- Tree view of disk usage (think GrandPerspective / WizTree / ncdu, but in a browser).
- Backup state comparison between disks: "what's on SSD but not HDD-A," "what differs between HDD-A and HDD-B," etc. This works even when only one HDD is connected, by comparing against the last-known indexed state of the other.
- Browse the indexed file tree without re-scanning.
- Visual quality matters — this is a tool the user will actually live in.

### 2.4 Performance
- Saturate USB-C / disk throughput. Don't be the bottleneck.
- All long-running tasks must report:
  - Files/sec
  - MB/sec
  - ETA / remaining time
- Concurrent scanning + copying where it makes sense (the HDD is the slow side; we can be reading/hashing the SSD while the HDD writes).

### 2.5 Explicit non-goals
- No cloud backup (cold local only).
- No multi-user / multi-tenant.
- Encryption is not required (cold storage on physically-controlled disks). Not opposed if cheap, but not a requirement.
- Deduplication across files is not required. (Single source, full copies are fine.)
- Not a NAS replacement.

---

## 3. Existing-tools research and why we're building custom

The user asked for two rounds of research before agreeing to build. Both came up dry for the specific combination of requirements. Summary:

### 3.1 Backup tools evaluated

| Tool | Open source | SQLite/queryable index | Resumable scan+copy with state | Rich web UI | Cold-USB workflow fit |
|---|---|---|---|---|---|
| **Restic** | ✅ | ❌ encrypted blob/pack repo | ⚠️ partial | ❌ | ❌ |
| **Kopia** | ✅ | ❌ same model as restic | ⚠️ partial | ⚠️ desktop only | ❌ |
| **UrBackup** | ✅ | ⚠️ internal DB | ✅ | ✅ | ❌ wrong shape (network backup server) |
| **Duplicati** | ✅ | ⚠️ SQLite local, custom on dest | ✅ | ✅ | ⚠️ history of corruption |
| **Borg / Borgmatic** | ✅ | ❌ | ⚠️ | ❌ | ❌ |
| **FreeFileSync** | ✅ | ❌ | ❌ not the same kind of resume | ⚠️ desktop | ⚠️ |
| **rsync / rclone** | ✅ | ❌ | ⚠️ partial | ❌ | ⚠️ |
| **BackDrop** | ✅ | ❌ | ⚠️ | ❌ Tkinter GUI | ✅ closest in intent |
| **Backrest** | ✅ | ❌ (wraps restic) | inherits restic | ✅ | ⚠️ |

### 3.2 Disk-explorer tools evaluated

`gdu`, `ncdu`, GrandPerspective, DaisyDisk, durs, dutree, parallel-disk-usage, etc. — all good at the tree-view part, none have any backup awareness or persistent multi-disk state.

### 3.3 Almost-fits worth knowing about (for inspiration / code reading)

- **fit** (github.com/StoneStepsInc/fit) — file-integrity tool with SQLite-backed scans, has a `-u` resume flag, documented schema. This is exactly the resumable-scan-into-SQLite pattern we want for the index layer. Worth reading the schema.
- **gdu** (github.com/dundee/gdu) — Go disk-usage analyzer, can persist to SQLite via `--db`. Good reference for parallel scan techniques.
- **Spacedrive v1/v2** (github.com/spacedriveapp/spacedrive) — Rust + SQLite file manager with BLAKE3 content hashing, ephemeral-vs-persistent index split, closure-table directory hierarchy, and "disconnected drives appear as offline" cross-device awareness. Closest architectural reference. **They abandoned the file-manager use case in v3 (March 2026)** and pivoted to an AI-data-engine. Not adoptable, but valuable to read.
- **redu** — ncdu-style disk explorer for restic repos. Validates that "disk explorer over a backup index" is something multiple people have wanted.

### 3.4 Specifically on restic (since Backrest looked promising)

Investigated restic's internals because Backrest is just a UI wrapper — the engine is restic. Conclusion: **restic is the wrong foundation.**

- **On-disk format on the HDD** is content-addressed, encrypted (AES-256-CTR + Poly1305-AES) pack files plus encrypted JSON indexes. **No SQLite.** Without the restic binary and the password, the HDD contents are opaque hex-named files. This permanently violates requirement 2.1.
- **Resumability** is at the "rerun and dedup via SHA-256 index" level, not at the "pause for 3 hours, see exactly what's done in a queryable DB, resume cheaply" level. Restic re-scans and re-hashes the entire source on every resume because scan state isn't persisted to disk. There's a multi-year-old open issue (#2960) about saving partial snapshots on SIGINT.
- **Progress reporting** is bytes-based and minimal; no rich files/sec, no per-file status visible externally.
- **CPU overhead** per byte: every blob is hashed (SHA-256), encrypted, authenticated, optionally compressed. Fine on a Mac mini, but it's not raw `cp` and the encryption is unwanted overhead given our threat model (cold storage on physically-controlled disks).

Three options for "build on restic" were considered — all compromised. The least-bad (use restic as copy engine + mirror its `--json` output into our own SQLite) ends up being most of the work of a custom build, while still leaving the user dependent on restic to ever read their data. **Rejected.**

What we *take* from restic as design influence:
- The "periodically flush index for crash safety" pattern.
- Two-phase scan → copy pipeline.
- `--json` streaming output for progress.
- Idea of content-defined chunking (Rabin CDC) — relevant only if we ever want incremental dedup later. Not in v1.

### 3.5 Verdict
No existing open-source tool combines all four pillars. The combo of **(a) SQLite-queryable file-tree index + (b) resumable scan and copy with persistent task state + (c) web UI with disk explorer and cross-disk diff + (d) built specifically for the rotating-cold-storage-USB-HDD workflow** does not exist off the shelf. Custom build is justified. **No "AI weekend project" on GitHub or HN nails this combo either** — recent vibe-coded projects in this space are subscription trackers or thin wrappers around restic/rclone, not the architecture we want.

---

## 4. Architecture decisions made so far

### 4.1 Stack
- **Server language:** Go OR Rust. Both will saturate USB-C without breaking a sweat. Go is faster to write/read; Rust gives stronger guarantees on a long-running data daemon. **This is the only major decision left open** — see Section 6.
- **Storage:** SQLite with WAL mode for everything (disk index, scan state, copy queue, history, jobs). Single source of truth. User must be able to open the DB in any SQLite browser and inspect.
- **Hashing:** BLAKE3, not SHA-256. Multi-GB/s on modern CPUs vs SHA-256's ~500 MB/s. Matters for the 4TB initial scan/copy.
- **Encryption / dedup:** None (out of scope per non-goals). Cold storage on physically-controlled disks doesn't need restic's threat model. Files on the HDD are stored as plain files in their original directory structure.
- **Web UI:** Whatever the chosen language is comfortable with. Server exposes JSON over HTTP; UI is a thin client. Good design quality is a real requirement.

### 4.2 Storage layout on each disk
The HDD destination should hold:
- The actual file copies, in their original tree structure (so the HDD is independently usable as a plain file system if the tool ever disappears).
- A small metadata sidecar (the SQLite DB, or a copy of it) at the root so the disk is self-describing — when you plug HDD-A in, the tool can identify the disk and load its known state without depending only on host-side state.
- Some kind of disk identity marker (UUID generated by the tool on first use) stored both in the DB and on the disk, so we can recognise it across reconnects and across host machines.

### 4.3 Core architectural patterns to borrow

From **fit**: SQLite schema for resumable scans — one row per file per scan, with a scanset concept and an explicit "this scan was interrupted, here's where to continue from" mechanism.

From **Spacedrive v2**: ephemeral-vs-persistent index split (browse instantly, promote to managed location later); closure tables for fast directory-hierarchy queries instead of recursive parent traversal; BLAKE3 content identity; treating disconnected drives as still in the index but marked offline.

From **gdu**: parallel directory scanning with a worker pool. The HDD scan especially benefits from concurrent reads even on a 5,400rpm drive (within reason — too much parallelism on a HDD causes seek thrashing).

From **restic**: periodic durable flush of in-progress state so a crash mid-job loses minutes, not hours.

### 4.4 Job model
Everything long-running is a **job** with durable state in SQLite:
- `scan` — walk a disk, hash files, populate the index
- `copy` — copy from source to destination, verify, mark done
- `verify` — re-hash a destination and compare to recorded hashes
- `diff` — compare two indexes (cheap; reads SQLite only)

Jobs are pausable, resumable, and crash-safe. They report progress (files/sec, MB/sec, ETA) via a state table the UI subscribes to (poll or SSE/WebSocket).

### 4.5 Schema sketch (to refine in Claude Code)
Top-level tables, not yet final:
- `disks` — known physical disks (UUID, label, capacity, last_seen_at, currently_connected)
- `scans` — a scan run on a disk (id, disk_id, started_at, completed_at, status)
- `files` — one row per (disk_id, path), with size, mtime, ctime, content_hash, last_scan_id
- `directories` — denormalised path closure for fast tree queries
- `backups` — a backup operation (source_disk_id, dest_disk_id, started_at, completed_at, status)
- `backup_files` — per-file backup status within a backup (file_id, status, copied_at, verified_at)
- `jobs` — job queue and state (id, type, status, payload_json, progress_json, started_at, updated_at)
- `disk_meta` — key/value config per disk

This schema is intentionally flat and queryable. Closure-table approach for `directories` avoids recursive CTEs being needed for tree views.

### 4.6 Performance design
- HDD-side reads/writes are the bottleneck. Don't oversubscribe the HDD with concurrent I/O; one or two parallel streams max.
- SSD-side reads can be heavily parallel.
- Hashing during copy: read once, hash and write in parallel pipeline so we don't traverse the source twice.
- BLAKE3 is fast enough that hashing isn't the bottleneck on a Mac mini.
- All long jobs flush state to SQLite at least every N seconds OR every M files, whichever comes first, so a power loss costs at most a small amount of work.

---

## 5. Interface and UX direction (intentionally light — to design properly in Claude Code)

- Single-pane web app. Sidebar lists known disks (online + offline visually distinguished).
- Click a disk → see tree view of its indexed contents, capacity stats, last-scan time, last-backup time.
- Top-level "Backups" view: list of backup operations across all disk pairs, with status and history.
- "Diff" view: pick two disks, see what's only-on-A, only-on-B, differing-content.
- Jobs tray (always visible): in-flight jobs with progress bars, files/sec, MB/sec, ETA, pause/cancel buttons.
- No login, no users — single-user local tool bound to localhost.

---

## 6. The one open decision: Go vs Rust

User has not chosen. Trade-offs:

**Go**
- Faster to write the web server, JSON handling, job queue.
- `database/sql` + `mattn/go-sqlite3` or `ncruces/go-sqlite3` (pure-Go) work well.
- Easy concurrency model for scan/copy workers (goroutines + channels).
- Single static binary deployment.
- Examples to learn from: gdu (Go disk scanner with SQLite), Backrest (Go web app with SQLite).

**Rust**
- Faster runtime, lower memory; matters less here than on shared servers but still nice.
- Stronger guarantees on a long-running data daemon (no nil panics in the copy loop).
- Ecosystem: `rusqlite` or `sqlx`, `tokio`, `axum` for HTTP.
- Examples to learn from: Spacedrive (Rust + SQLite + BLAKE3 + Tauri, very close to our stack).
- Slower to iterate.

The user should make this call before any code is written. Recommendation if undecided: **Go** for the v1 — the speed-of-development advantage matters more than the runtime gains at this scale, and the gdu / Backrest reference codebases are directly applicable.

---

## 7. Suggested first-week milestones for Claude Code

Roughly in order:

1. **Skeleton:** project layout, chosen language, SQLite with WAL, single binary that boots and serves a `/healthz`.
2. **Schema migrations:** define the tables in Section 4.5, write a migration runner.
3. **Disk identity & registration:** detect mounted disks on the Mac, register them, write a disk-id sidecar file.
4. **Scan job (the hard one — get this right):** parallel directory walker, hashing, durable progress, resumable. Test on the 4TB SSD first (fast path), then the HDD.
5. **Web UI shell:** enough to list disks and trigger/observe jobs.
6. **Tree view of one disk's index:** virtualised list, fast even with millions of rows.
7. **Copy job:** scan-aware copy (only copy what's missing or changed), with verification.
8. **Diff view:** two disks side-by-side.
9. **Polish:** progress reporting, ETAs, pause/resume UX, error handling.

Don't try to do all of these at once. The scan job is the architectural keystone — if its resumability story is wrong, everything else is wrong.

---

## 8. Things explicitly to NOT do

- Don't add encryption "just in case." It's out of scope and will pollute the on-disk format.
- Don't add deduplication "just in case." Same reason. Plain file-tree copies are what the user wants.
- Don't add cloud backends. Local-only.
- Don't add scheduling/cron logic in v1. The user runs backups manually when they connect a HDD. (Easy to add later.)
- Don't reach for restic, kopia, or any other backup engine as a dependency. The whole point of building this is to own the format.
- Don't build a fancy CLI as the primary interface. Web UI is the product. A small CLI for diagnostics is fine.

---

## 9. What this conversation explicitly did NOT decide

These are deferred to the implementation phase:
- Final SQLite schema (Section 4.5 is a sketch).
- Whether the on-disk file copies preserve full metadata (xattrs, resource forks on macOS) — needs a quick test on real Mac files.
- Frontend framework. Pick whatever pairs well with the chosen server language and looks good.
- Whether to use SSE, WebSocket, or polling for live job progress. SSE is probably the simplest fit.
- Authentication — likely none for v1 (localhost only, single user).
- How exactly to detect drive connect/disconnect events on macOS.

---

## 10. North star for design decisions

When in doubt, optimise for: **the user can plug a disk in, the tool recognises it, they can browse it, see its backup state, kick off whatever job they want, walk away, come back later, and the tool tells them exactly what happened — and the SQLite DB underneath is something they could query themselves with `sqlite3` if they ever wanted to.**

The four pillars again, for reference:
1. Open source + queryable metadata
2. Fully resumable, fully stateful
3. Rich web UI for backup management AND general disk inspection
4. Fast — saturate the hardware, never be the bottleneck

If a design choice helps one pillar at the cost of another, escalate it; don't quietly trade off.
