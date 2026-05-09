# Waypoint — Claude Code Rules

## RULE: All filesystem I/O must go through the two fs/ gateway files

**Read operations:** `apps/api/src/fs/disk-io.ts`
**Write operations:** `apps/api/src/fs/disk-writes.ts`

This is a hard rule with no exceptions (outside of `__tests__/`).

### What this means

No source file in `apps/api/src/` (other than these two files and test files)
may directly use any of the following:

- `import ... from "fs"`
- `import ... from "fs/promises"`
- `Bun.file(...)` for reading or writing
- `Bun.write(...)`
- `appendFileSync`, `readFileSync`, `writeFileSync`, `readdirSync`
- `readdir`, `mkdir`, `copyFile`, `rename`, `unlink` from `fs/promises`
- `Bun.spawnSync` for disk-related tools (`df`, `diskutil`)

Instead, call the corresponding exported function from `disk-io.ts` (reads)
or `disk-writes.ts` (writes).

### Why this rule exists

This tool writes to backup disks containing irreplaceable personal data.
Splitting reads and writes into separate files means:
- To audit what can cause data loss: read only `disk-writes.ts` (~100 lines).
- To audit all disk access: read both files together (~300 lines total).

A reviewer never has to grep the whole codebase to understand disk exposure.

### Adding new I/O

- New **read** operation → add to `disk-io.ts`.
- New **write** operation → add to `disk-writes.ts`, with explicit guardrails
  (validate the target path, refuse to overwrite unless that is the explicit intent).
- Do NOT inline fs calls anywhere else.

### Exceptions

- `apps/api/src/__tests__/**` — test setup/teardown may use `fs` directly.
- `apps/api/src/db/client.ts` — SQLite database file is opened via `bun:sqlite`, not `fs`.
- `apps/web/` — frontend has no filesystem access.
