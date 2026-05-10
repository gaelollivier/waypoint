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

---

## RULE: Fail fast — hard-assert internal invariants, never swallow them

When an internal invariant is violated (a code path that "cannot happen" if the
program is correct), **throw immediately with a descriptive error**. Do not:

- Use `?? fallback` to silently paper over a missing value that should always be present.
- Use `continue` / `return` to skip an item that should always exist.
- Log a warning and carry on, producing silently incorrect results downstream.

**Why:** Silent invariant failures produce wrong output (e.g. files missing from
a diff, aggregates off by thousands of bytes) with no indication anything went
wrong. A thrown error surfaces the bug immediately and prevents data-loss
decisions from being made on corrupted state.

**How to apply:**

- If a `Map.get()` or DB query result must be non-null at that point in the
  code, assert it: `if (value === undefined) throw new Error("invariant: ...")`.
- Reserve `?? fallback` for **genuine optionals** — values that are legitimately
  absent in normal operation (e.g. a nullable FK that is expected to sometimes
  be null).
- Reserve `catch`-and-continue for **external I/O errors** (permission denied,
  disk missing) where partial progress is better than aborting the whole job.
  Internal logic errors are not in this category.
- Add a short comment explaining *why* a value is guaranteed to be present, so
  the next reader understands the invariant and doesn't defensively weaken it.
