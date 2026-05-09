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
- **The I/O contract:** ALL filesystem operations must go through
  `apps/api/src/fs/disk-io.ts`. No other source file (outside `__tests__/`)
  should import from `fs`, `fs/promises`, or use `Bun.file`/`Bun.write` directly.

## What to review

### 1. Enforce the I/O boundary

Search every `.ts` file under `apps/api/src/` (excluding `__tests__/` and
`disk-io.ts` itself) for direct filesystem imports or calls:

- `from "fs"` or `from "fs/promises"`
- `Bun.file(` or `Bun.write(`
- `readFileSync`, `writeFileSync`, `appendFileSync`, `readdirSync`
- `readdir(`, `mkdir(`, `copyFile(`, `rename(`, `unlink(`

Report any violation as a **CRITICAL** finding. The rule exists specifically to
make this audit possible — a violation undermines the entire safety model.

### 2. Audit `disk-io.ts` write operations

Read `apps/api/src/fs/disk-io.ts` in full. For every function marked `// WRITE:`:

- What file path does it write to? Can an incorrect path cause writes to the
  wrong disk or location?
- Does the operation overwrite existing data? If so, is there a guard?
- Is there any atomicity concern? (e.g. crash mid-write leaves a partial file)
- Is the function called only from appropriate places?

### 3. Audit the copy job (if it exists)

If `apps/api/src/jobs/copy/` exists, review it carefully:

- **Path construction:** Are destination paths constructed correctly from source
  paths? Could a path traversal bug write outside the intended destination?
- **Overwrite logic:** What happens if the destination file already exists? Is
  the existing backup file safe?
- **Verification:** Is the copy verified after writing (e.g. hash comparison)?
  A copy that silently produces a corrupted file is as bad as no copy.
- **Partial progress:** If the job is paused or crashes mid-copy, what state is
  the destination file in? Can it be safely resumed or detected as incomplete?
- **Disk full:** What happens if the destination disk runs out of space
  mid-copy? Is the partial file detected and handled?
- **Error handling:** Are errors per-file isolated, or does one failure abort
  the whole job and leave the destination in an inconsistent state?

### 4. Audit the diff job

Read `apps/api/src/jobs/diff/diff-job.ts`:

- Does the diff correctly identify all file states: added, removed, changed, present?
- Could a hash collision cause a changed file to be misidentified as present
  (i.e., the copy job would skip a file that needs updating)?
- Is the diff result used safely by the copy job — no TOCTOU race between
  diff completion and copy execution?

### 5. Scan job safety

Read `apps/api/src/jobs/scan/walker.ts` and `hasher.ts`:

- Are iCloud stub files (SF_DATALESS) correctly detected and skipped?
- Could an error in hashing cause a file to be recorded with a null or wrong
  hash, leading to incorrect diff results later?
- Is mtime/size caching safe? Could a file be updated between stat and hash?

### 6. General risks

- **Database integrity:** Does the DB schema enforce foreign keys and NOT NULL
  where required? A missing or NULL hash in a critical column could silently
  skip files during diff.
- **Disk identity:** Could two disks accidentally receive the same UUID? Could
  a UUID collision cause the wrong disk to be treated as a backup destination?
- **Lock safety:** Does the lock manager prevent two copy jobs from writing to
  the same destination disk simultaneously?

## Output format

Structure your report as:

### CRITICAL (data loss risk)
Items that could cause data loss or silent corruption. Must be fixed before the
copy job is used on real data.

### WARNING (reliability risk)
Items that could cause the backup to be incomplete or require manual recovery.

### INFO (improvement opportunity)
Items that are not immediately dangerous but would make the system more robust.

### PASS
Areas that were reviewed and found safe.

Be specific: cite the file path and line number for every finding. If there are
no findings in a category, write "None found."
