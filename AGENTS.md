# Waypoint — Agent Instructions

This is the single authoritative rules file for any agent working in this
repo (Claude Code, Cursor, etc.). It bundles working-practice guidance and
the full text of the project's hard rules. There is no separate `CLAUDE.md`.

Before making changes, read:

- `AGENTS.md` (this file)
- `.claude/commands/`
- `docs/START-HERE.md`
- `docs/agent-api.md` (the HTTP API surface you'll query)

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

## Querying the system

**Read state through the HTTP API first.** `docs/agent-api.md` is the
canonical map of what is exposed (file/directory/scan queries with
filters and cursors, audit log, etc.) — it is the paved path for any
agent reading or writing state. If the doc is out of date, fix it
there rather than working around it.

**SQL escape hatch:** for queries no endpoint exposes, run
`bun run sql -c "SELECT …"`. It opens `~/.waypoint/waypoint.db`
read-only; writes are rejected on purpose. Every time you reach for
the script, append a one-line entry to `docs/agent-api-gaps.md` so we
can promote popular query shapes into real endpoints next time.

**Writes go through the API, never direct SQL.** Every mutating
endpoint writes a row to `audit_log` in the same transaction
(`recordAudit` in `apps/api/src/lib/audit.ts`). New write endpoints
MUST emit an audit entry so future reverts can reconstruct the prior
state.

## Default workflow

- Work directly on `main`; do not create feature branches or pull requests
  unless the user explicitly asks for one
- Inspect `git status -sb` and the staged diff before committing
- Commit changes after each completed task or step
- **Test in the UI, not via curl.** The user only validates features through
  the browser. Reserve curl for backend debugging — and even then, run it
  yourself rather than handing the user a curl command to paste.

## Presenting plans

When presenting a plan for review, keep it high-level: short bullets, no
sub-prose, no exhaustive file lists. The user reads the bullets and asks for
detail on whatever needs digging into. Don't pre-empt with deep design.

Surface design decisions one at a time as short summaries; wait for the
user to ask before expanding. The user wants to keep direction in their
hands and not discover a wrong choice after a lot of work has been done.

## Naming — full words, no abbreviations

Code identifiers, filenames, DB column / table names, API routes, and
documentation use full English words. The most common offender:
**"duplicate", not "dupe"** — anywhere a job runner, table, route, or
component is named (`DuplicateDetectionJobRunner`, `duplicate_groups`,
`/api/disks/:id/duplicates`). The shorthand is fine in casual chat,
never in artifacts.

## UI architecture — disk page is the primary surface

Users think in disks, not jobs. The disk detail page owns all
user-facing operations for that disk: progress, charts, events,
errors, history. The job detail page (`/jobs/:id`) is a debug-only
surface — do not add features there that aren't also in the shared
`JobDetails` component.

- Build the shared `JobDetails` once (progress, charts, events,
  controls) and embed it in both `DiskDetailPage` (when a job is
  active) and `JobDetailPage`.
- Disk-scoped events/errors aggregate every job that touched the
  disk; job-scoped views live on the job page only.
- Pause/resume/cancel controls live inside `JobDetails` so both
  surfaces get them.
- Applies to every job type — scan, copy, verify, backup, encoder,
  frame-extract, future ones.

## Remote browser — never use OS dialogs or client-only paths

The user reaches the web UI from a separate device (phone, laptop on
LAN). The browser is NOT on the server. Any feature relying on the
client machine matching the server machine is broken:

- No `osascript` folder pickers, no native OS dialogs, no
  `showOpenFilePicker`.
- File / folder pickers must be server-side: API endpoints that
  list the server's filesystem, rendered as a tree in React.
- "Open in Finder" / "reveal in file manager" can be offered but only
  as a same-machine convenience; never the primary path.

## URLs to share with the user

When you send the user a UI link, use the LAN IP of the web app:

```
http://192.168.x.x:5173/<path>
```

- **Port 5173** is the Vite dev server (web app). The browser always
  hits this; Vite proxies `/api` + `/healthz` to the API on :3000.
- **Port 3000** is the API only — useful for curl checks you run
  yourself, not for the user.
- **Never `localhost`** — the user's browser is on a different
  device. Discover the LAN IP at link-share time:
  `ipconfig getifaddr en0` (Wi-Fi) or `en1`. If neither returns,
  ask rather than guess.

## Working around `bun --watch` for long jobs

`bun run dev` runs the API under `bun --watch`. Any source edit
restarts the API process and kills in-flight jobs — scans, copies,
media-metadata extraction, ffmpeg encodes — without a clean resume.

When you need to edit source while a long job is running:

1. Create a worktree off `main`:
   `git worktree add -b <feature-branch> /path/to/worktree main`
2. Run tests, typecheck, and commits inside the worktree. Tests use
   an in-memory DB so they don't touch live state.
3. Do NOT start a second `bun run dev` in the worktree — it would
   open the same `~/.waypoint/waypoint.db` and at minimum confuse
   the disk-lock manager.
4. When the job finishes, merge the feature branch into `main` on
   the original worktree. The watcher restarts cleanly once with the
   new code.
5. `git worktree remove` when done.

If you only need to inspect / query while a job runs, just use the
HTTP API or the read-only `bun run sql` — no edits, no restart.

## Cleanup suggestions — sizing and card layout

When the agent posts cleanup suggestions to
`POST /api/disks/:id/cleanup/suggestions`, bundle aggressively into
fewer, larger batches. A batch with >500 members is fine — the user
explicitly prefers reviewing fewer batches. Do not split a coherent
rule into N sub-batches just to shrink failure blast radius;
mid-batch apply failures don't roll back the rows already deleted,
and the user can retry.

The Suggestions tab card layout (in
`apps/web/src/components/CleanupSuggestionsTab.tsx`) has two
non-obvious constraints set by the user:

1. **Action buttons (Apply / Dismiss) live at the TOP of the card**,
   immediately after the header summary and any stale warning. Not
   the bottom — the user reviews many cards and shouldn't scroll for
   large batches.
2. **Member-row list collapses past the first 20 rows** behind a
   "Show N more (X total)" toggle. Files in a single batch follow a
   similar pattern, so the user scans a sample before deciding.

Card order: header summary → stale warning (if any) → Apply/Dismiss
buttons → rationale → "in `<prefix>`" → first 20 member rows →
"Show N more" toggle.

When extending the card, keep buttons above the path list and do not
undo the collapse-by-default behavior.

## `/review` and acknowledged-gap workflow

When the user triages a `/review` finding as "by design" or "won't
do", record it in `docs/decisions.md` under "Acknowledged review
gaps" and update the `/review` skill / script to filter that pattern
out of future reports. The user doesn't want to see the same known
gaps re-reported every cycle.

Before presenting a review report, compare findings against the
acknowledged-gap list and surface a previously-acknowledged gap
only if the situation has materially changed.

## Private notes — out of repo

Anything tied to the user's real disks, paths, or content lives under
`~/.waypoint/`, never in this repo. The layout:

- `~/.waypoint/waypoint.db` (+ snapshot / WAL files) — the live SQLite
  database. Not a note, not editable by hand; the app owns it.
- `~/.waypoint/notes/` — **all notes and ad-hoc scratch work.** Anything
  outside the DB belongs here.
  - `~/.waypoint/notes/disks/<id>-<label>.md` — per-disk private notes:
    scan-error analysis, known corruption patterns, recovery plans, any
    context that references real paths or filenames.
  - `~/.waypoint/notes/dupe-analysis/` — scratch directory for ad-hoc
    dedup analysis (dated session logs, batch-builder scripts, exported
    JSON).
  - Other subdirs may be added here freely for new ad-hoc workstreams.

When you start work on a specific disk, check
`~/.waypoint/notes/disks/<id>-<label>.md` first — it captures context
that the DB alone doesn't preserve (e.g. "files matching pattern X in
this subtree are physically unreadable due to FS corruption"). When you
learn something durable about a disk during a session, write it back to
that file rather than to a memory record or a checked-in doc.

This split exists because of the "no personal data in checked-in
artifacts" rule below: per-disk notes inevitably contain real paths and
filenames, so they cannot live in `docs/` or any tracked file.

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

### Pairwise comparison batches

For *candidate* duplicates that aren't byte-identical (similar size, name,
capture year, etc.) the agent can ask the user to verdict them pair-by-pair
in a side-by-side viewer. Verdicts feed back as ground truth about which
"plausible duplicate" signals are safe enough to act on later.

The intended loop:

1. The agent identifies candidate pairs from any heuristic (sidecar year +
   size band, basename within year, perceptual hash, etc.).
2. The agent POSTs to `/api/comparisons` with
   `{ name, rationale?, members: [{ leftPath, rightPath, leftSizeBytes?,
   leftContentHash?, rightSizeBytes?, rightContentHash?, note? }] }`.
   Cross-disk pairs are allowed.
3. The agent sends the user the URL `/compare/:batchId` (per-pair deep links
   via `?m=<memberId>`).
4. The user walks through the batch in the UI and verdicts each pair as
   `same` / `different` / `unsure`, optionally with a note.
5. The agent reads verdicts back from `GET /api/comparisons/:batchId` and
   uses them to inform later cleanup decisions (e.g. only auto-propose
   cleanups in size bands the user has confirmed as `same`).

The viewer streams media via `GET /api/media?path=<absolute>` with HTTP
Range support so the browser's `<video>` element can seek; `?download=1`
flips to an attachment disposition for the unrenderable-format fallback
link. Requested paths are normalised and must resolve under a registered
disk's `mount_path`.

What the agent must NOT do here:

- **Don't fabricate verdicts on the user's behalf.** The verdict POST is
  reserved for the human reviewer in the UI.
- **Don't write the user's real paths, file names, or batch rationales into
  commits, code comments, or docs.** The same redaction rule that applies
  to `/cleanup/*` endpoints applies to comparison member paths and notes.

### Media metadata extraction

For cross-tree duplicate detection where the bytes differ but the underlying
shot is the same (e.g. Google's storage-saver re-encodes vs the local
original), the agent can ask Waypoint to pull EXIF / QuickTime metadata into
a queryable `media_metadata` table. Then candidate matching can layer
`same datetime_original + same camera make/model` onto basename or size band
to dramatically reduce false positives.

Kick it off:

```
POST /api/disks/:id/media-metadata
Body: { scanId?: number, pathPrefix?: string }
```

- `scanId` defaults to the latest completed scan for the disk.
- `pathPrefix` restricts extraction to that subtree (must be inside the
  disk's mount). Useful to extract one big tree at a time on an HDD.

The job is idempotent — it skips files that already have a
`media_metadata` row. To re-extract, delete the row first. Datetime
priority for video is `com.apple.quicktime.creationdate` → `date` →
`creation_time`; for images we read `DateTimeOriginal`, falling back to
`CreateDate`. Unsupported extensions (sidecars, archives, text) are not
even enqueued.

Querying it (read-only sqlite3 in `~/.waypoint/waypoint.db`):

```sql
SELECT f.path, mm.datetime_original, mm.make, mm.model
  FROM files f
  JOIN media_metadata mm ON mm.file_id = f.id
 WHERE mm.captured_at_unix IS NOT NULL
   AND mm.make = 'Apple'
   AND mm.captured_at_unix BETWEEN ? AND ?;
```

The `media_metadata_join` index covers `(captured_at_unix, make, model)`
so EXIF-keyed joins across trees stay cheap.

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

### Corollary: no shell-level deletes on registered disk mounts

`rm`, `rm -rf`, `unlink`, `find -delete`, or any other shell or
direct-fs deletion against a path under `/Volumes/<disk>/` (or any
registered disk mount) is forbidden — even for cleanup of files the
agent created itself in the same session, even for "obviously safe"
hidden directories like `.waypoint-encoding-scratch/`. The mount
root defines "off-limits", not the file's apparent origin.

For unwanted files / directories the agent created on a registered
disk, the options are:

1. Use a Waypoint API endpoint that routes through
   `apps/api/src/fs/disk-writes.ts` and emits an `audit_log` row. If
   no such endpoint exists yet, add one rather than reaching for
   `rm`.
2. Ask the user to delete it manually.

Smoke tests that write to a real disk must have a clean teardown
path in place before the first write. If there isn't one, build it
first or use a staging path under `/tmp/`. The host SSD outside disk
mounts (`~/.waypoint/`, `/tmp/`) follows normal common sense, but
the same bias toward "ask first" applies when something looks
valuable.

The whole safety architecture (`disk-writes.ts` gateway, the
human-only deletion rule above, browser-only cleanup guardrails)
exists specifically to make this class of incident impossible.
Shelling out around it makes the architecture meaningless.

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
