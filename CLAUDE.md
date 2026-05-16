# Waypoint — Claude Code Rules

## RULE: All filesystem I/O must go through the two fs/ gateway files

**Read operations:** `apps/api/src/fs/disk-reads.ts`
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

Instead, call the corresponding exported function from `disk-reads.ts` (reads)
or `disk-writes.ts` (writes).

### Why this rule exists

This tool writes to backup disks containing irreplaceable personal data.
Splitting reads and writes into separate files means:
- To audit what can cause data loss: read only `disk-writes.ts` (~100 lines).
- To audit all disk access: read both files together (~300 lines total).

A reviewer never has to grep the whole codebase to understand disk exposure.

### Adding new I/O

- New **read** operation → add to `disk-reads.ts`.
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

---

## RULE: Database queries must be backed by deliberate indexes

Waypoint operates over large scan snapshots. A query that is logically correct
but accidentally scans a whole snapshot on a hot path can freeze the server and
make safety-critical UI state stale.

### What this means

- When adding or changing a non-trivial query, **always check whether its filter
  and join shape have an appropriate backing index**.
- Prefer sargable predicates on real columns. Be suspicious of `CASE`,
  `COALESCE`, functions, or casts in hot `WHERE` clauses when they prevent an
  otherwise useful index from being used.
- Most production queries should have a deliberate index story. If a query is
  intentionally allowed to scan, call that out explicitly in code/docs and make
  the tradeoff visible for review.
- When a query is performance-sensitive or runs per item/group, verify the plan
  with `EXPLAIN QUERY PLAN` or equivalent before considering the change done.

### Why

A single bad query shape can turn an O(log n) lookup into repeated full-snapshot
scans. Duplicate detection already hit this failure mode once: an expression-
based lookup defeated the hash index and caused long event-loop stalls.

---

## RULE: File deletions must NEVER be initiated by an LLM or agent

**This is a hard rule with zero exceptions.**

Waypoint manages irreplaceable personal data. Deleting a file is a
**permanent, destructive** action. All deletions must be:

1. **Initiated from the web UI** by a human user clicking a button.
2. **Confirmed via a dialog** listing every file about to be deleted.
3. **Validated server-side** before execution (see below).

### Server-side guardrails (enforced in the API)

Every deletion request is rejected unless **all** of the following hold:

- The request includes `"initiatedFromWebUI": true` in the body.
- The `User-Agent` header looks like a real browser (not `curl`, not an SDK,
  not a script).
- The files to delete are confirmed duplicates in the database.
- At least one identical copy of each file is **not** being deleted.

### What this means for Claude Code / any LLM agent

- **Do NOT call the deletion endpoint.** Even if you have the right payload,
  the server will reject non-browser user agents.
- **Do NOT attempt to bypass the `initiatedFromWebUI` flag or User-Agent
  check.** These exist specifically to prevent automated deletions.
- **Do NOT write code that programmatically triggers deletions** outside of
  the web UI's confirmation flow.
- **Do NOT weaken, remove, or refactor away any of these guardrails.** If a
  change touches the deletion path, the `/review` skill must be run.

### Why this rule exists

A single accidental bulk-delete of backup data is catastrophic and
irreversible. Requiring human initiation via a browser UI — with an explicit
confirmation step — is a deliberate friction layer that prevents automated
tools from causing data loss.

---

## RULE: Never put the user's personal data in checked-in artifacts

This repo is open source. Anything that lands in git history (commits,
docs, code comments, READMEs) is permanent and public-adjacent. Treat all
data the tool reads from the user's disks as sensitive.

### What this means

Do NOT include any of the following in commit messages, code comments,
docs (`README.md`, `docs/**`, `CLAUDE.md`, etc.), or any other file in
the repository:

- Specific file or folder names from the user's disks (e.g. real video
  filenames, photo album names, paths under `/Volumes/<their-disk>/...`).
- Specific file sizes tied to an identifiable real file ("the 9.14 GB
  video", "the 26 GB MKV").
- The user's live disk labels (the labels in the local SQLite DB).
- Output snippets pasted into chat that contain any of the above.

Numbers and ratios about the system are fine ("scan throughput ~800 MB/s",
"~3.5 TB across ~173K files"). Specifics tied to identifiable user content
are not.

### How to apply

- Before writing a commit message, scan it for any string that came from
  reading the SQLite DB, a scan output, or a `/Volumes/...` path. Strip it.
- In bench / debug output the user pastes back, treat the data as
  sensitive. Discuss numbers in chat; redact specifics before they land
  in any file.
- If a result genuinely requires a path to make sense, use a redacted
  placeholder like `/Volumes/<disk>/file.ext` or `<large video file>`.
- For existing leaks already in pushed commits, flag to the user and let
  them choose remediation (rewriting history is destructive and requires
  explicit instruction). Sanitize the working tree at minimum.

### Why this rule exists

Test data and bench output that mention real personal content can leak
through commit messages and bug post-mortems without anyone noticing.
Even after redaction in a new commit, prior commits are still in public
git history. The only durable defense is to never write the data down in
the first place.
