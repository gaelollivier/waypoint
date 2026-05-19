# Waypoint — Agent Instructions

This is the single authoritative rules file for any agent working in this
repo (Claude Code, Cursor, etc.). It bundles working-practice guidance and
the full text of the project's hard rules. There is no separate `CLAUDE.md`.

Before making changes, read:

- `AGENTS.md` (this file)
- `.claude/commands/`
- `docs/START-HERE.md`

## Commands — always use these, never bare tools

Run from the repo root. The root `package.json` fans out to both workspaces.

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Dev server (API + web) | `bun run dev` |
| Typecheck both workspaces | `bun run typecheck` |
| Run API tests | `bun run test` |
| Watch tests | `bun run test:watch` |
| Production build | `bun run build` |

**Do not call `tsc`, `vite`, `bunx tsc`, `bun build`, or `bun --watch ...`
directly.** Use the scripts above so:

- behavior matches CI and the user's local loop,
- a missing tool surfaces as "add a script" rather than per-agent invention,
- output stays consistent across sessions.

If the workflow you want isn't covered by an existing script, add one to the
appropriate `package.json` (root or workspace) and document it here. Don't
work around the missing script with an ad-hoc invocation.

## Default workflow

- After every change, open a pull request into `main`
- Inspect `git status -sb` and the staged diff before committing
- Prefer creating the PR with `gh pr create` after pushing the branch

## Presenting plans

When presenting a plan for review, keep it high-level: short bullets, no
sub-prose, no exhaustive file lists. The user reads the bullets and asks for
detail on whatever needs digging into. Don't pre-empt with deep design.

## Agent-driven cleanup workflow

Waypoint's duplicate cleanup is human-initiated, but an LLM agent can
*propose* cleanups via three disk-scoped HTTP surfaces. None of these can
delete files — they're advisory rows in SQLite. Every deletion still goes
through `/api/disks/:id/duplicates/cleanup`, which enforces browser-only
guardrails (see the rule below).

The intended loop:

1. The user runs a scan and duplicate detection on a disk.
2. The agent reads past keep/delete patterns from
   `GET /api/disks/:id/cleanup/history` (paged deletion events with sibling
   paths for each deleted file).
3. The agent writes its inferred rules to
   `PUT /api/disks/:id/cleanup/notes` (freeform markdown, one blob per disk).
   The user reviews the notes in the **Notes** tab on the disk page.
4. The agent reads remaining duplicate groups via the existing
   `/api/disks/:id/duplicates` endpoint and posts proposals to
   `POST /api/disks/:id/cleanup/suggestions` with
   `{ contentHash, keepPath, deletePaths, sizeBytes, rationale }`.
5. The user opens the **Suggestions** tab, sees each proposal as a card with
   keep/delete paths + rationale, and either taps Apply or Dismiss. Apply
   calls the existing `/duplicates/cleanup` endpoint (full guardrails apply),
   then `POST /cleanup/suggestions/:id/applied`.

Suggestions are keyed by **paths + content_hash**, not by scan-snapshot
`file_id` or `duplicate_group_id`. This is deliberate: when the user
re-scans + re-runs duplicate detection after a cleanup session, every
remaining pending suggestion resolves against the new snapshot automatically.
If a path is gone or the hash drifted on disk, the suggestion is reported as
`resolved: false` with a `staleReason` string — the UI shows it but disables
Apply.

### Excluded paths

The user can mark a directory (or single file path) as "ignore for
duplicate-detection purposes" via `GET / POST / DELETE
/api/disks/:id/excluded-paths`. Files at or under an excluded path are
filtered from both the Phase 1 GROUP BY and the per-group member lookups in
`duplicate-job.ts`. Scan, diff, and copy are intentionally NOT affected —
the file is still indexed and still copied; it just doesn't surface as a
duplicate-detection candidate.

Agents may read the exclusion list (e.g. to understand why a previously
suggested group has disappeared, or to mention the exclusion in `notes`).
Agents should NOT add or remove exclusions on their own — these are
user-curated decisions about what "duplicate" means on a given disk.

What an agent must NOT do here:

- **Never call `/api/disks/:id/duplicates/cleanup` directly.** That endpoint
  rejects non-browser User-Agents anyway, but the rule is wider: agents
  don't initiate deletions, period. Suggestions are the agent's only path.
- **Never modify the User-Agent check or `initiatedFromWebUI` flag** to make
  the cleanup endpoint callable from a non-browser client.
- **Don't add or delete excluded paths on the user's behalf.** Surface
  candidates in `notes` or suggestion rationale and let the user act on
  them via the UI.
- **Don't write any of the user's real paths or file names from these
  endpoints into commits, code comments, or docs.** Everything you read via
  `/cleanup/history`, `/duplicates`, or `/excluded-paths` is the user's
  personal data — see the rule below.

---

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
- **Agent-driven cleanup suggestions are NOT a back-door.** Posting to
  `/api/disks/:id/cleanup/suggestions` is fine — those rows are advisory
  and never invoke deletion. The Apply button on the Suggestions tab goes
  through the same guardrailed `/duplicates/cleanup` endpoint as manual
  cleanup; the human still pulls the trigger.

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
docs (`README.md`, `docs/**`, `AGENTS.md`, etc.), or any other file in
the repository:

- Specific file or folder names from the user's disks (e.g. real video
  filenames, photo album names, paths under `/Volumes/<their-disk>/...`).
- Specific file sizes tied to an identifiable real file ("the 9.14 GB
  video", "the 26 GB MKV").
- The user's live disk labels (the labels in the local SQLite DB).
- Output snippets pasted into chat that contain any of the above.
- Paths or rules pulled from `/api/disks/:id/cleanup/notes`,
  `/cleanup/history`, or `/cleanup/suggestions` — those are derived from
  the user's real disk content and the same redaction applies.

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
