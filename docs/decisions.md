# Design Decisions

Settled decisions from the research phase. These are not up for re-discussion unless new information changes the calculus. Open questions live in `open-questions.md`.

---

## Safety constraints (hard, non-negotiable)

- **Additive-only writes.** The backup copy job only ever creates new files. It never overwrites, renames, or deletes files at the destination.
- **No deletion code in the codebase.** Not in the copy job, not in the diff view, not anywhere. If a cleanup operation is ever needed, it happens manually by the user.
- **No sync semantics.** Files removed from the source are never removed from the destination. The backup is a one-way accumulation.
- **If a file already exists at the destination:** hash it and compare to the source hash. If they match → skip, log as `already_present_verified`. If they don't match → error, log, surface for manual review. Never overwrite.
- **Orphaned temp files** (from interrupted copies) are surfaced in the UI for manual cleanup. Never auto-deleted.
- **Scanning is read-only.** No writes to source or destination during scan/inspect operations, except to the SQLite metadata DB on the host.

## Error handling

- All errors are logged per-file in SQLite with a status field and error detail text. Nothing is silent.
- The UI prominently surfaces an error/review count after any job.
- Errored files are individually retryable from the UI without re-running the full job.
- Non-fatal errors (e.g. xattr copy failure) are tracked separately from fatal errors that abort a file.

## Storage format

- **SQLite with WAL mode** for everything: file index, scan state, job queue, history. `synchronous=NORMAL` minimum; `synchronous=FULL` for job state table if warranted.
- **Never `synchronous=OFF`** (gdu's approach — crash-unsafe).
- **Plain file copies** on the HDD in their original directory structure. No content-addressed format, no encryption, no dedup. Files on the HDD are independently usable without this tool.
- **Self-describing disk**: a dotfile (`.backup-tool-disk-id`) with a UUID written on first use. Used to identify the disk across reconnects. Same pattern as Spacedrive's `SPACEDRIVE_VOLUME_ID_FILE`.
- A copy of (or symlink to) the SQLite DB is stored at the HDD root so the disk carries its own index.

## Hashing

- **BLAKE3** everywhere. Not SHA-256 (slower), not xxHash (not cryptographic enough for integrity verification).
- **Full BLAKE3** always during copy jobs (free — we're reading every byte anyway).
- **Full BLAKE3** always during verify jobs.
- Hashing strategy for scans (initial and re-scans) is an open question — see `open-questions.md` item 3.

## Atomic writes

- **Temp→rename pattern** for all file copies: write to `filename.backup-tmp-<uuid>` in the same directory, then rename to final name on completion.
- Rename is atomic on POSIX — no reader ever sees a partial file.
- fsync strategy is an open question — see `open-questions.md` item 1.

## Architecture

- **Client/server**: Go or Rust daemon + JSON over HTTP + web UI. Single binary. Bound to localhost, no auth.
- **Language**: Go vs Rust still open. Go recommended for v1 (iteration speed, simpler concurrency model). No code written yet.
- **Web UI**: server-sent events (SSE) for live job progress. Thin client, JSON API.
- **No CLI as primary interface.** A small diagnostic CLI is acceptable; the web UI is the product.

## Jobs

- Every long-running operation is a **job** with durable state in SQLite: `scan`, `copy`, `verify`, `diff`.
- Job statuses: `queued → running → paused / completed / failed / cancelled`.
- Jobs are pausable and resumable. Crash mid-job is treated the same as pause.
- Job metrics tracked: `bytes_processed`, `items_processed`, `warnings_count`, `non_critical_errors_count`.
- Jobs report progress (files/sec, MB/sec, ETA) via SSE.

## Explicit non-goals (v1)

- No encryption.
- No deduplication.
- No cloud backends.
- No scheduling/cron.
- No multi-user.
- No sync semantics (source deletions are not propagated to destination).
- No restic/kopia/borg as a dependency.
