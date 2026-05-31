# Agent API gaps

> Every time you fall back to `bun run sql` because no API endpoint
> covers your need, add a one-line entry below. Describe the **shape**
> of the query, not the disk-specific specifics. The entry is a TODO
> for the next time we add endpoints.

**Hard rules for entries here:**

- No real paths from the user's disks. Use placeholders like
  `<photo-tree>`, `<google-backup>`, `<year-folder>`.
- No real file names, sizes tied to identifiable files, or disk
  labels from the local DB.
- No content snippets pasted from `bun run sql` output — describe what
  you needed, not what you saw.

The format is a tight punch list:

```
- <query shape> → covered by <endpoint>? [yes/no/partial]
  reach-for: <date> session-id <short reason>
```

When an entry is solved by a new endpoint, leave it here and append
the resolving PR / endpoint name so future-you can confirm it was
intentional. Don't delete entries — the history of what was asked is
useful when triaging the next round of additions.

---

## Open gaps

- "Which disks have media_metadata extracted, and how completely?" → no
  endpoint; had to SELECT with a LEFT JOIN per disk. Would fit either on
  `GET /api/disks/:id/scans` (per-scan media coverage count) or as a new
  field on `GET /api/disks`. reach-for: 2026-05-30 picking encoding samples.

---

## Resolved

_(empty)_
