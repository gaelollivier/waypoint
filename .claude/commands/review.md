# Safety Review — Waypoint Backup Tool

You are performing a safety audit of the Waypoint backup tool. This tool reads
from and writes to personal backup disks containing irreplaceable data. Data loss
is catastrophic and unacceptable. The bar for safety is much higher than a
typical application.

## Context

- **What Waypoint does:** Scans source and backup disks, identifies what needs
  copying, and (in the copy job) physically copies files from source to backup.
- **Why this is critical:** Backup disks hold the only copies of personal files.
  Any bug that corrupts, truncates, overwrites, or silently skips a file on the
  backup disk could mean permanent data loss.
- **The I/O contract:**
  - ALL read operations go through `apps/api/src/fs/disk-io.ts`.
  - ALL write operations go through `apps/api/src/fs/disk-writes.ts`.
  - No other source file (outside `__tests__/`) may import from `fs`,
    `fs/promises`, or use `Bun.file` / `Bun.write` / `Bun.spawnSync` directly.

## What to review

### 1. Enforce the I/O boundary (check this first)

Search every `.ts` file under `apps/api/src/` (excluding `__tests__/`,
`disk-io.ts`, and `disk-writes.ts`) for direct filesystem imports or calls:

- `from "fs"` or `from "fs/promises"`
- `Bun.file(` or `Bun.write(`
- `readFileSync`, `writeFileSync`, `appendFileSync`, `readdirSync`
- `readdir(`, `mkdir(`, `copyFile(`, `rename(`, `unlink(`

Report any violation as a **CRITICAL** finding. A violation means a write could
reach a backup disk without going through the audited gateway.

### 2. Audit disk-writes.ts in full

Read `apps/api/src/fs/disk-writes.ts` completely. For every exported function:

- **`writeDiskIdDotfile`**: Does the no-overwrite guard actually fire before
  the write? Could `Bun.file().exists()` return a stale result in any race?
  Is the filename guard redundant but harmless, or could it be bypassed?
- **`appendToTmpLog`**: Does the `/tmp/` prefix check prevent writes to any
  path that matters? Could `WAYPOINT_TRACE_PATH` be set to something dangerous?
- **`createDirectory`**: Is `{ recursive: true }` safe if the directory already
  exists? Could a carefully crafted path escape the intended destination?
- Are there any write functions not yet used (i.e. dead code being added
  prematurely)? Flag as WARNING — unused write surface is unnecessary risk.

### 3. Audit disk-io.ts for accidental write capability

Read `apps/api/src/fs/disk-io.ts` completely. Verify:
- No function in this file can modify any file on disk.
- `Bun.spawnSync` calls are read-only tools (`df`, `diskutil`) — not shells or
  commands that could write.

### 4. Audit the copy job (if it exists)

If `apps/api/src/jobs/copy/` exists, review it carefully:

- **Path construction:** Are destination paths constructed correctly from source
  paths? Could a path traversal bug (`../`, absolute paths in filenames) write
  outside the intended destination disk?
- **Overwrite logic:** What happens if the destination file already exists?
  Is the existing backup copy preserved or silently replaced?
- **Verification:** Is each copied file verified after writing (hash comparison)?
  A copy that silently produces a corrupted or truncated file is as bad as no copy.
- **Partial progress:** If the job is paused or crashes mid-file, what state is
  the destination file in? Is it detectable as incomplete and safe to retry?
- **Disk full:** What happens when the destination disk runs out of space?
  Is the partial file cleaned up or left as a corrupt artefact?
- **Error isolation:** Does one file's failure abort the whole job, or are errors
  per-file? Either answer has trade-offs — just verify it's intentional.
- **Streaming write design:** The copy job is expected to stream-read chunks and
  compute a rolling hash in-flight (rather than blind OS copy + post-hash).
  Verify this is implemented — a two-pass approach (copy then hash) has a TOCTOU
  window where a disk error between passes goes undetected.

### 5. Audit the diff job

Read `apps/api/src/jobs/diff/diff-job.ts`:

- Does the diff correctly identify all file states: `added`, `removed`,
  `changed`, `present`?
- Could a sampled-hash collision cause a changed file to be classified as
  `present`, causing the copy job to skip it?
- Is the diff result stable — i.e. is there a TOCTOU risk between when the diff
  runs and when the copy job acts on it?

### 6. Audit the scan job

Read `apps/api/src/jobs/scan/walker.ts` and `hasher.ts`:

- Could a hashing error leave a file with `sampled_hash = NULL`? If so, would
  the diff job treat it as `changed` (safe) or `present` (dangerous)?
- Is mtime+size caching safe? If a file is modified between `stat` and `hash`,
  could a stale hash get written to the DB?

### 7. General risks

- **Database integrity:** Check FK constraints and NOT NULL columns. A NULL
  hash or missing `disk_id` on a file row could silently break diff results.
- **Disk identity:** Could two disks receive the same UUID? (They shouldn't —
  `crypto.randomUUID()` is used — but check that `writeDiskIdDotfile` refuses
  to overwrite an existing ID.)
- **Lock safety:** Does the lock manager prevent concurrent copy jobs from
  writing to the same destination disk simultaneously?
- **Same-disk diff/copy:** Is diffing or copying a disk against itself detected
  and blocked? Writing back to the source disk would be catastrophic.

## 8. Filter against acknowledged gaps

Before writing the final report, read `docs/decisions.md` § "Acknowledged review
gaps". Any finding that matches an acknowledged gap should be **silently
dropped** from the report — do not include it in CRITICAL, WARNING, or INFO.

If a previously-acknowledged gap has gotten **worse** (e.g. new code increases
the blast radius), report it as a new finding and note that the original gap was
acknowledged but the situation has changed.

## Output format

### CRITICAL (data loss risk)
Things that could cause data loss or silent corruption. Must be fixed before
the copy job is used on real data.

### WARNING (reliability risk)
Things that could cause the backup to be incomplete or require manual recovery.

### INFO (improvement opportunity)
Not immediately dangerous, but would make the system more robust.

### PASS
Areas reviewed and found safe — be specific about what was checked.

Cite file path and line number for every finding. If there are no findings
in a category, write "None found."
