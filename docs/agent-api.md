# Agent API surface

> **If this doc is out of date, fix it here — don't work around it.** Stale
> docs lead to throwaway scripts that re-query the DB. Update this file or
> the underlying endpoint until the doc matches reality. Same goes for the
> SQL escape hatch: every time you reach for it, ask whether the endpoint
> should be added instead.

Waypoint's HTTP API is the paved path for any agent (Claude, scripts, the
web UI) that needs to read or change the system. This doc lists the
read-side endpoints an agent will use 95% of the time, the SQL escape
hatch for the long tail, and the convention for promoting gaps into real
endpoints.

All endpoints are JSON unless noted. Server runs on `http://localhost:3000`.

---

## Querying disks

### `GET /api/disks`
List every registered disk. Each row carries `id`, `label`, `kind`
(`ssd|hdd`), `mount_path` when mounted, and the `last_scan_job_id`
denormalised cache.

### `GET /api/disks/:id`
One disk by id.

### `GET /api/disks/:id/scans`
Every scan job for this disk, newest first. Each row reports `id`,
`status`, `createdAt`, `startedAt`, `completedAt`, `fileCount`,
`totalSizeBytes`, `sampledHashCount`, `fullHashCount`, and
`requestedFullHash`. The top-level `latestScanId` echoes the disk's
denormalised pointer — that is the scan most other endpoints default to.

Useful for: "which scan am I looking at, and does it have full hashes?".
Distinct from `/duplicates/scans`, which is the duplicate-cleanup
eligibility view.

---

## Browsing the tree

### `GET /api/disks/:id/tree?parentId=…&parentPath=…&scanId=…`
Returns the direct children (subdirectories + direct files) of one
directory, sorted largest-first. Defaults to the disk root in the
latest scan. Best for an interactive drill-down — for "everything under
this prefix", use `/files` instead.

### `GET /api/disks/:id/directories`
Query directories across an entire scan. Filters:

- `pathPrefix` — only directories at or under this absolute path.
  Trailing slashes are stripped.
- `parentPath` — only direct children of this directory.
- `name` — SQL `LIKE` pattern (use `%` as wildcard).
- `minDepth` / `maxDepth` — depth relative to the disk root (root = 0,
  direct children = 1, etc.).
- `sizeMin` — bytes; filters `total_size_bytes`.
- `sort` ∈ {`id`, `size`, `fileCount`, `path`, `name`}. `size` defaults
  to descending; everything else defaults to ascending.
- `order` ∈ {`asc`, `desc`}.
- `scanId` — override the default (latest scan).
- `limit` (default 50,000, `0` = effectively unlimited up to 1M).
- `cursor` — opaque token returned in `nextCursor`.

Response:

```json
{
  "diskId": 1,
  "scanId": 310,
  "entries": [
    { "id": 42, "scanId": 310, "parentId": 41, "name": "...",
      "path": "...", "totalSizeBytes": 0, "fileCount": 0,
      "directFileCount": 0, "depth": 1 }
  ],
  "truncated": false,
  "nextCursor": null
}
```

Use this for any "list year-folders" / "list direct subdirs" walk that
the older scripts did with `path LIKE 'foo/%'` over the whole subtree.

---

## Querying files

### `GET /api/disks/:id/files`
The workhorse. Returns the file rows for the chosen scan snapshot, with
optional media metadata join. Filters compose:

| Param | Notes |
|---|---|
| `pathPrefix` | absolute path; matches the path itself or anything under it |
| `name` | SQL `LIKE` pattern, e.g. `%.MP4` or `IMG_%` |
| `ext` | comma-separated list of extensions, e.g. `mp4,mov,avi` |
| `sizeMin` / `sizeMax` | bytes |
| `sampledHash` / `fullHash` | exact hash lookup (indexed) |
| `capturedFrom` / `capturedTo` | unix seconds; joins `media_metadata` automatically |
| `durationMin` / `durationMax` | seconds; joins `media_metadata` automatically |
| `make` / `model` | exact match on lowercase camera fields |
| `hasMediaMetadata` | `true` requires a media row, `false` requires absence |
| `sort` | `id` (default), `size`, `path`, `name`, `mtime`, `capturedAt` |
| `order` | `asc` / `desc`. `size` defaults to `desc`. |
| `scanId` | override the default (latest scan) |
| `include` | `media` opt-in: adds the metadata sub-object to each row |
| `limit` | default 50,000, max 1,000,000. `0` ⇒ max. |
| `cursor` | opaque cursor from `nextCursor` |

Response:

```json
{
  "diskId": 1,
  "scanId": 310,
  "entries": [
    { "id": 1, "scanId": 310, "directoryId": 100,
      "name": "...", "path": "...",
      "sizeBytes": 1234, "mtime": "2024-01-01",
      "sampledHash": null, "fullHash": null,
      "media": { /* present iff include=media */
        "capturedAtUnix": 1700000000,
        "datetimeOriginal": "2023-11-14T12:00:00",
        "datetimeSource": "exif",
        "durationSeconds": 12.5,
        "make": "apple", "model": "iphone 15"
      }
    }
  ],
  "truncated": false,
  "nextCursor": null
}
```

When `truncated` is `true`, pass `nextCursor` back in the same query to
fetch the next page. Filters and sort stay the same across pages.

### `GET /api/disks/:id/files/by-path?path=…&include=media`
Single file lookup by absolute path. 404 if the path is not in the
latest (or specified) scan.

### `GET /api/disks/:id/files/:fileId?include=media`
Single file lookup by id. Useful when an earlier query returned the id.

---

## Browsing what changed

### `GET /api/audit`
Paged list of every mutation the API performed. Filters:

| Param | Notes |
|---|---|
| `diskId` | only entries scoped to this disk |
| `action` | exact action string, e.g. `excluded_path_add` |
| `targetKind` | e.g. `file`, `comparison_batch`, `cleanup_suggestion` |
| `targetId` | matches `target_id` |
| `since` / `until` | ISO8601 bounds on `created_at` |
| `limit` | default 200, max 50,000. `0` ⇒ max. |
| `cursor` | opaque cursor from `nextCursor` |

Newest first. Each row carries the action, actor (`ui|agent|system`),
disk, target, `before`/`after` snapshots, and an arbitrary
`metadata` blob. See the "Audit log" section below.

### `GET /api/audit/:id`
Single entry.

---

## Other useful read endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/jobs` | list jobs |
| `GET /api/jobs/:id` | one job |
| `GET /api/jobs/:id/events` | SSE stream of live job progress |
| `GET /api/jobs/:id/events-log` | persisted event log for one job |
| `GET /api/disks/:id/diff?destDiskId=…&parentPath=…` | diff tree for a source↔dest pair |
| `GET /api/disks/:id/diff/jobs` | history of diff jobs |
| `GET /api/disks/:id/duplicates?...` | duplicate groups for a disk |
| `GET /api/disks/:id/duplicates/scans` | duplicate-cleanup-eligible scans |
| `GET /api/disks/:id/excluded-paths` | list dedup-exclusion paths |
| `GET /api/disks/:id/cleanup/notes` | per-disk markdown blob (agent notes) |
| `GET /api/disks/:id/cleanup/history` | paged deletion history for a disk |
| `GET /api/disks/:id/cleanup/suggestions?status=…` | agent-driven cleanup proposals |
| `GET /api/comparisons` | comparison batches |
| `GET /api/comparisons/:batchId` | one batch with members |
| `GET /api/media?path=…` | streams a file (Range support) — used by the comparison viewer |

---

## Audit log

Every mutating endpoint writes a row to the `audit_log` table inside the
same DB transaction as the underlying change. The intent is
revertibility: capture enough before/after state that a future revert
endpoint can restore prior state without re-deriving it.

Fields:

- `action` — stable snake_case string. Examples below.
- `actor` — `ui` (request looked like a browser), `agent` (other clients
  hitting the API), or `system` (background, no request).
- `disk_id`, `target_kind`, `target_id`, `target_path` — narrow the row
  to what was touched. `target_kind` strings are free-form but stable;
  the ones in use today are listed below.
- `before_json` / `after_json` — JSON snapshots scoped to revertibility,
  not full diffability. NULL on creates / deletes respectively.
- `metadata_json` — extra context (e.g. duplicate group id, suggestion
  id, comparison batch id, job id).
- `revertible` — author's claim. Defaults to 1.

Actions emitted today:

| Action | Target kind | Notes |
|---|---|---|
| `excluded_path_add` | `excluded_path` | after = row |
| `excluded_path_remove` | `excluded_path` | before = row |
| `cleanup_notes_update` | `agent_notes` | before/after = `{ body, updatedAt }` |
| `cleanup_suggestion_create` | `cleanup_suggestion` | after = batch + members |
| `cleanup_suggestion_apply` | `cleanup_suggestion` | status transition; per-file deletes get their own rows |
| `cleanup_suggestion_dismiss` | `cleanup_suggestion` | status transition |
| `duplicate_cleanup` | `file` | before = file row + `keptFile`; metadata = group + triggering context |
| `duplicate_directory_cleanup_file` | `file` | per-file delete inside a directory-group cleanup |
| `duplicate_directory_cleanup_directory` | `directory` | the parent directory record |
| `comparison_batch_create` | `comparison_batch` | after = batch summary; metadata = members |
| `comparison_batch_delete` | `comparison_batch` | before = batch + members |
| `comparison_verdict` | `comparison_member` | before/after = verdict triple |

**Do NOT introduce a write endpoint without an audit entry.** Every
mutation should be reversible from the audit log alone.

---

## SQL escape hatch — `bun run sql`

Use the HTTP API first. When you genuinely need a query that no
endpoint exposes, fall back to the script — and write down the gap so
we can fill it.

```bash
bun run sql --schema                    # list tables
bun run sql --schema files              # CREATE for one table
bun run sql -c "SELECT id, label FROM disks"
bun run sql < ./scripts/some_query.sql
bun run sql -c "SELECT …" --format=table
```

The script opens `~/.waypoint/waypoint.db` **read-only**. Writes are
rejected by SQLite with `attempt to write a readonly database`. That
is intentional — every write must go through the API so it lands in
the audit log.

**What you should do every time you fall back:** append a one-line
entry to `docs/agent-api-gaps.md` describing the *shape* of the query
you needed, abstracted away from any disk-specific details. We
periodically promote the popular shapes into real endpoints.

If you find yourself doing the same fallback twice in one session,
that is the signal to file the endpoint instead.

---

## Conventions for endpoint authors

- Every disk-scoped query defaults to the disk's `last_scan_job_id`.
  Accept `?scanId=` to override.
- Path filters strip trailing `/` so `/foo` and `/foo/` behave the
  same.
- Pagination: soft cap at 50k rows, return one extra to detect more,
  expose an opaque `nextCursor`. `limit=0` raises the cap to 1M (so
  whole-disk dumps don't force pagination).
- Filter parsing must reject unknown sort keys (400). Unknown filters
  are ignored — they were probably typos.
- Mutating endpoints MUST write an `audit_log` row in the same
  transaction. Use `recordAudit` from `apps/api/src/lib/audit.ts`.
- Never store the user's real disk content in checked-in artifacts —
  see the rules in `AGENTS.md`.
