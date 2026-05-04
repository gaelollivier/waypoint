# Research: fit & gdu

## fit (StoneStepsInc/fit)

fit is a C++ file-integrity tracker (not Go/Rust — no code reuse, but architecture is directly relevant). Its core purpose is exactly our scan layer: walk a directory tree, hash every file, persist everything to SQLite, and support resumable runs via `-u`.

**Schema design** is the most valuable thing to borrow. fit uses a two-level split: `files` (one row per unique path, stable identity), `versions` (one row per file per scan — hash, size, mtime, scan_id). This cleanly separates "what file exists at this path" from "what was the state of that file at time T." The `scans` table tracks each scan run with `scan_time`, `completed_time`, `last_update_time`, `cumulative_duration`, and `times_updated` — these last three were added specifically to support resumability (schema v8.0). Schema versions are stored in SQLite's `PRAGMA user_version` with structured upgrade scripts per version — a good migration pattern.

**Resumability** via `-u` works like this: the `scansets` table is a join table between `versions` and `scans` (many-to-many: a scan run "contains" a set of file versions). On resume, fit starts a new scan row but with `base_scan_id` pointing at the previous run. The `scanset_bitmap_t` is a per-thread bit array, one bit per rowid from the prior scan; bits are cleared as files are confirmed in the new run. After the run, remaining set bits = files that existed in the base scan but weren't found in the resume scan (i.e. removed or inaccessible). Multiple threads each build their own bitmap, then merge via `update()`. **Progress is tracked with `std::atomic<uint64_t>` counters** (files, bytes, errors, new/modified/removed).

**SQLite config:** fit explicitly sets WAL mode and warns if it can't. It does NOT use `PRAGMA synchronous = OFF` — correctness over raw speed.

**Key limitation for us:** fit's resume is "re-scan and compare to prior" — it doesn't pick up from where it left off in the middle of a directory walk. It re-walks from the top each time. For a 4TB SSD this is fast; for a 5400rpm HDD this is the slow path we want to avoid.

---

## gdu (dundee/gdu)

gdu is a Go disk-usage analyzer with an optional SQLite backend (`--db`). It's directly in our language family and the parallel scan design is the most valuable reference.

**Concurrency model** (`pkg/analyze/parallel.go`): a simple channel-as-semaphore at the top of the file — `concurrencyLimit = make(chan struct{}, 2*runtime.GOMAXPROCS(0))`. Every goroutine processing a subdirectory acquires a slot before working and releases it before draining child results (to avoid deadlock when the channel fills). Files within a directory are processed synchronously on the goroutine that owns the directory; only directory recursion is parallelized. This is exactly the right model for HDD scanning: per-file parallelism would cause seek thrashing, per-directory is sane.

**SQLite schema** (`pkg/analyze/sqlite.go`): flat `items` table — `(id, parent_id, name, is_dir, size, usage, mtime, item_count, mli, flag)` plus `metadata(key, value)` key-value store. Parent-child hierarchy stored via `parent_id` foreign key with an index on `(parent_id, name)`. Uses recursive CTE for ancestor updates (not a closure table — fine for gdu's use case, but recursive CTEs on millions of rows are slower than closure tables). The `mli` field stores inode numbers for hard-link deduplication.

**Critical warning — SQLite pragmas:** gdu's SQLite storage uses `PRAGMA synchronous = OFF; journal_mode = MEMORY`. This maximizes insertion speed but offers **zero crash safety** — any interruption corrupts the DB. This is the wrong choice for us. gdu can afford it because it's a throw-away analysis cache; we cannot.

**"Resumability"** in gdu is minimal: if `HasData()` returns true (DB has rows), it loads from the DB instead of scanning. There is no partial scan continuation — a mid-scan crash leaves the DB in whatever state the last committed transaction left it, and the next run either loads that incomplete state or rescans from scratch. Not a model to copy for our use case.

**Bulk insert pattern** is worth copying: `BeginBulkInsert()` opens one transaction and prepares statements; `EndBulkInsert()` commits. All goroutines serialize through a `dbWriteMu sync.Mutex` — single writer, simple, correct. The tradeoff vs WAL multi-reader is negligible when the bottleneck is disk I/O.

---

## Key Takeaways

### Schema patterns
- **files + versions split** (fit): separates stable identity from per-scan state. Valuable for tracking history.
- **PRAGMA user_version for schema versioning** (fit): cleaner than a separate `schema_migrations` table.
- **metadata(key, value)** (gdu): trivial to add, solves "where did I put this disk's UUID" type problems without schema churn.
- **parent_id with (parent_id, name) index** (gdu): works for simple tree queries. Closure table is faster for deep subtree aggregations but more complex.

### Resumability patterns
- fit's scanset bitmap is clever but only tracks "what was seen vs what was in the prior scan" — it doesn't resume mid-walk.
- For true mid-walk resume (our requirement), we need a different approach: persist the walk queue itself (a table of not-yet-scanned directories), so on resume we continue from the remaining queue rather than restarting at the root.

### Correctness patterns
- fit uses WAL mode explicitly — treat this as mandatory, not optional.
- fit's atomic progress counters are the right model for thread-safe progress reporting without lock contention.
- Neither tool implements read-after-write verification. That's a gap we should fill.

### Performance patterns
- gdu's `2*GOMAXPROCS` semaphore for directory-level parallelism is the right model. For HDD, consider `1` or `2` as the limit; for SSD, `2*GOMAXPROCS` is fine.
- Bulk-insert via a single transaction + prepared statements (gdu) is the right default for scan inserts. Fine-tune checkpoint frequency for resume safety.
- gdu's `synchronous = OFF` is explicitly NOT for us — use WAL + `synchronous = NORMAL` which gives crash safety with acceptable performance.

### Things that challenge the handoff doc
- The handoff assumes resumable scan = "continue from last position." fit shows that "compare to last scan" is simpler and more common — but for a 5400rpm HDD it's genuinely too slow. Our approach of persisting the walk queue as a SQLite table is the right call but less validated in the wild.
- gdu's parent_id approach (not closure table) works fine for browsing a single level. Closure tables only pay off for queries like "total size of all files under /foo/bar" — which we do need. Closure table is confirmed right for our tree view.
