# Waypoint — Claude Code Rules

## RULE: All filesystem I/O must go through `disk-io.ts`

**File:** `apps/api/src/fs/disk-io.ts`

This is a hard rule with no exceptions (outside of `__tests__/`).

### What this means

No source file in `apps/api/src/` (other than `disk-io.ts` itself and test files)
may directly use any of the following:

- `import ... from "fs"`
- `import ... from "fs/promises"`
- `Bun.file(...)` for reading or writing
- `Bun.write(...)`
- `appendFileSync`, `readFileSync`, `writeFileSync`, `readdirSync`
- `readdir`, `mkdir`, `copyFile`, `rename`, `unlink` from `fs/promises`
- `Bun.spawnSync` for disk-related tools (`df`, `diskutil`)

Instead, call the corresponding exported function from `../fs/disk-io`.

### Why this rule exists

This tool writes to backup disks that contain irreplaceable personal data.
The copy job, in particular, must never corrupt or silently lose a file.
Centralising I/O in one ~200-line file makes it possible to audit every disk
operation before it runs — a reviewer need only read `disk-io.ts` to understand
everything the tool can do to a disk.

### Adding new I/O

If you need a new filesystem operation:
1. Add it to `disk-io.ts` with a clear docstring.
2. Mark write operations with a `// WRITE:` comment.
3. Do NOT inline fs calls anywhere else.

### Exceptions

- `apps/api/src/__tests__/**` — test setup/teardown may use `fs` directly.
- `apps/api/src/db/client.ts` — SQLite database file is opened via `bun:sqlite`, not `fs`.
- `apps/web/` — frontend has no filesystem access.
