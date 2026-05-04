# Research: Correctness & Verification Best Practices

Sources: restic (`internal/backend/local/local.go`, `internal/fs/`, `internal/checker/`), borg (`crypto/file_integrity.py`, `platform/`), general SQLite documentation.

---

## 1. Atomic Writes and Partial File Handling

**Restic's implementation is the gold standard** (`internal/backend/local/local.go:120-184`):

```
1. tempFile(dir, basename+"-tmp-")     → creates temp file in same directory as destination
2. io.Copy(f, rd)                       → write data
3. verify wbytes == expected length     → sanity check before sync
4. f.Sync()                             → fsync the file (flush to disk); ignore ENOTSUP
5. f.Close()
6. os.Rename(tmp, final)               → atomic POSIX rename
7. sync parent directory               → commit the rename to disk
```

Key points:
- **Temp file in the same directory** as the destination — ensures rename is on the same filesystem (no cross-device rename failure).
- **fsync before rename** — guarantees data is on disk before the filename becomes visible. Without this, a crash after rename but before OS flush leaves a zero-length or partial file under the final name.
- **Rename is atomic on POSIX** — no reader ever sees a partial file. The file either exists with its old content or the new content, never partial.
- On error, the temp file is removed. The deferred cleanup runs `os.Remove(f.Name())` — cleans up even on panic.
- **Byte count verification** before sync: if `io.Copy` copied fewer bytes than `rd.Length()`, the write is aborted. This catches truncated writes early.

**For us:** Every file written to the HDD must use this pattern: write to `filename.backup-tmp-<random>`, fsync, close, rename. Any interrupted copy leaves only the temp file, never a corrupt final file. On resume, scan for `*.backup-tmp-*` files and remove them before starting.

---

## 2. Hashing on the Fly (Borg Pattern)

**Borg's `FileHashingWrapper`** (`crypto/file_integrity.py`) wraps a file-like object and hashes all bytes as they pass through `read()` or `write()`. The hash is computed in a single pass — no second read of the data.

This is the right pattern for us: **read source → hash → write to destination**, all in one pipeline. At the end of the copy, we have both the written bytes and the hash of what was written. We compare this to:
1. The hash we computed during the source scan (stored in SQLite).
2. A re-read of the destination file (optional post-copy verify pass).

Using BLAKE3 (multi-GB/s) means hashing is never the bottleneck even on a Mac mini copying to a 5400rpm HDD (bottleneck is ~150-200 MB/s write speed).

---

## 3. Verification Strategies

**What restic's `check` command does:**
- Loads all index files and verifies their internal consistency (no missing blobs, no orphaned blobs).
- Optionally reads all pack files and verifies their hashes (`--read-data`).
- This is a *separate pass* from the backup operation — not read-after-write.

**Read-after-write vs separate verify pass — tradeoffs:**

| | Read-after-write | Separate verify pass |
|---|---|---|
| Detects copy errors | ✅ immediately | ✅ but later |
| Detects post-copy bit rot | ❌ (by definition) | ✅ if run periodically |
| Performance cost | ~2× read time | Separate job, schedulable |
| Complexity | Low (same pipeline) | Slightly higher |

**Recommendation for our tool:**
- **Always do read-after-write** during a copy job: hash the bytes as we write them, compare to the source hash stored in SQLite. If they differ, mark the file as `error_hash_mismatch` and log. Do not delete the written file — log the error for manual review.
- **Implement a separate `verify` job**: walk the destination, re-hash every file with BLAKE3, compare to stored hashes. Flag any mismatches. This detects bit rot introduced *after* the copy. Given the drives are cold storage HDDs, a periodic verify (e.g. every 6 months) is prudent.

---

## 4. SQLite WAL Mode — What It Protects Against

**WAL mode (Write-Ahead Logging):**
- All writes go to a separate WAL file first. On checkpoint, they're applied to the main DB file.
- **A crash mid-transaction** leaves the WAL file with an incomplete transaction. On next open, SQLite rolls it back — main DB is untouched. **No corruption.**
- **`synchronous=NORMAL` in WAL mode**: only the WAL file is synced on commit (not every page). SQLite guarantees no corruption on OS crash; you might lose the last committed transaction on a power failure (the WAL commit record isn't fsynced). This is acceptable for our use case.
- **`synchronous=FULL`**: every write is fsynced. Slowest, maximum durability. Worth considering for job state (the jobs table), less so for the file index.
- **`synchronous=OFF`** (gdu's choice): zero crash safety. Never use this.

**What WAL does NOT protect against:**
- Filesystem-level corruption (unrelated to SQLite).
- Bugs in our code that write incorrect data (WAL ensures writes are durable, not correct).

**Recommended config for our DB:**
```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;   -- safe for the index
PRAGMA wal_autocheckpoint=1000;  -- checkpoint every 1000 pages
```
For the `jobs` table specifically, consider a separate DB file with `synchronous=FULL`.

---

## 5. Silent Data Corruption

**How real is it on HDDs?**
- Consumer HDDs have an unrecoverable read error rate (URE) of ~1 in 10^14 bits = 1 error per ~12.5 TB read. A 4TB scan has ~30% probability of a single bit error per read. Over multiple read/write cycles, this accumulates.
- "Silent" corruption (bit flip that passes the HDD's own ECC) is rarer but real, especially on aging drives.
- APFS has built-in checksumming for metadata but NOT for file data (unlike ZFS). File data on APFS can be silently corrupted.

**What ZFS/Borg/Restic do:**
- ZFS: every block has a checksum; scrub re-reads all blocks and verifies. Hardware-enforced.
- Restic: every blob is SHA-256 hashed; the hash IS the blob's address. Any corruption changes the hash, making the blob "missing." `restic check --read-data` detects this.
- Borg: same content-addressed model; `borg check` re-reads and verifies.

**For our tool:** Since we store plain files (not content-addressed), we depend entirely on our stored BLAKE3 hashes. The `verify` job is the equivalent of ZFS scrub — it re-reads every file on the HDD and compares to the stored hash. We should expose this as a first-class operation with its own progress/result stored in SQLite.

---

## 6. macOS-Specific Concerns

**iCloud dataless files** (restic `stat_darwin.go`): Files synced to iCloud but not yet downloaded locally have `SF_DATALESS` flag set. Reading them triggers a download. We should detect this flag and either skip or warn — never silently hash a 0-byte stub.

**Extended attributes and resource forks:**
- macOS files can have xattrs (e.g. `com.apple.quarantine`, `com.apple.ResourceFork`, Finder color labels stored in `com.apple.FinderInfo`).
- Restic reads and stores all xattrs (`nodeRestoreExtendedAttributes`). For a backup tool that stores plain files, we have two options:
  1. **Copy xattrs explicitly** using `xattr` syscalls after copying the data. This preserves Finder metadata, quarantine flags, etc.
  2. **Log xattrs in SQLite but don't copy them** (v1 simplification). The file data is safe; xattrs can be restored later if needed.
- **Resource forks** (`com.apple.ResourceFork`) contain legacy Mac metadata. Modern apps rarely use them, but older documents (pre-2000 Mac files) may depend on them. For personal records, copying them is safer.
- **Recommendation for v1:** Copy xattrs using `golang.org/x/sys/unix` (or equivalent). Log any xattr copy failures as non-critical errors. This is a few extra syscalls per file — negligible overhead.

**USB-C disconnect mid-copy:**
- The OS returns `EIO` (I/O error) on the next write to the disconnected drive. Our atomic write pattern handles this correctly: the temp file write fails, the rename never happens, the error is logged, the job is paused/failed. On reconnect, the job resumes from the last checkpointed position in the queue.

---

## 7. Key Takeaways for Our Tool

1. **Atomic writes are non-negotiable:** write-to-temp → fsync → rename → sync parent dir. Never write directly to the final path.

2. **Hash as you copy:** single-pass pipeline. At end of each file copy: compare written hash to stored source hash. Mismatch = `error_hash_mismatch`, logged, never silent.

3. **Verify job is essential:** separate job that re-reads the destination and checks every file's BLAKE3 hash against stored values. The user should run this periodically. Results stored in SQLite with per-file status.

4. **All errors are logged, nothing is silent:** per-file error status in `backup_files`, with `error_detail` text. UI surfaces error count prominently. Individual files can be retried.

5. **SQLite config:** WAL + `synchronous=NORMAL` for the file index. `synchronous=FULL` for the jobs table if we want to be conservative. Never `synchronous=OFF`.

6. **iCloud stub detection:** check `SF_DATALESS` flag before hashing/copying. Skip with warning.

7. **xattr handling:** copy xattrs after the data copy. Log failures as non-critical errors. Important for macOS Finder metadata preservation.

8. **Temp file cleanup on resume:** before starting any job, scan destination for `*.backup-tmp-*` files left by a prior interrupted run and remove them. Log what was cleaned up.
