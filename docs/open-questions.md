# Open Questions & Follow-up Items

These are unresolved design decisions that need dedicated discussion before implementation. Each has enough context to pick up cold.

---

## 1. fsync strategy during file copies

**What we know:**
- fsync per file on a 5400rpm HDD would destroy throughput — forces a full disk flush after every file.
- Restic fsyncs every pack file, but their model requires it (the index references the pack; if the pack isn't durable, the index is corrupt). Our model is different.
- The temp→rename pattern (write to `.tmp`, then rename) ensures no partial file exists at the destination path. Rename is essentially free.
- SQLite WAL handles its own crash safety independently.

**What we need to decide:**
- Do we fsync individual files at all, or rely on OS write cache + the temp→rename pattern?
- If not per-file, do we fsync in batches (every N files, or every N MB written)?
- What exactly does the recovery look like if the OS crashes mid-copy with unflushed buffers? (Files in write cache but not yet on disk — the rename happened but the data wasn't flushed.)
- Is the SQLite job state (marking a file as `written`) written before or after the rename? If after, a crash between rename and DB update means a file exists on disk with no DB record — is that detectable on resume?

**Key tension:** safety (fsync = durable) vs. performance (fsync = slow). The answer probably involves batched fsyncs or accepting that the DB's `written` flag is a best-effort marker and the verify job is the real correctness guarantee.

---

## 2. Walk queue and resumable scanning at scale

**What we know:**
- No existing tool truly resumes a directory walk mid-way. They all re-scan from root and compare to prior state.
- The handoff doc proposes persisting the walk queue as a SQLite table of pending directories, so a resume continues from remaining dirs rather than restarting.
- Concern: deep/wide directory trees (e.g. `node_modules`) could explode the queue size — hundreds of thousands of entries, pathological seek patterns on the HDD.

**What we need to decide:**
- Is a persisted walk queue the right model at all, or is there a simpler alternative?
- If yes: how do we bound queue size? Options include: directory-level only (not individual files), max-depth limits, explicit exclude patterns (node_modules, .git, etc.).
- Exclude patterns are almost certainly needed regardless of the resume model. How are they configured?
- Alternative: "scan from root, but skip paths already marked complete in the DB." Simpler, but on a cold HDD the full root traversal is itself slow even if most dirs are skipped quickly.
- How does resume interact with directories that were partially scanned (some files indexed, walk interrupted mid-directory)?

---

## 3. Hashing strategy and performance

**What we know:**
- Full BLAKE3 on every file during initial scan of 4TB ≈ several minutes on modern CPU (BLAKE3 is fast, ~6-10 GB/s), but still non-trivial.
- Spacedrive uses **sampled hashing** for change detection: read 8KB header + 4×10KB interior samples + 8KB footer = ~58KB regardless of file size. Fast for "has this changed?" checks.
- `mtime` + `size` from the filesystem (essentially free — no file read needed) can serve as a quick "probably unchanged" signal, the same way rsync's default works.

**What we need to decide:**
- For the initial scan: full BLAKE3 always, or mtime+size first and only hash if changed/new?
- For re-scans: use mtime+size as a fast filter (skip if unchanged), only re-hash files that look modified?
- For the copy job: full hash inline during copy (free, since we're reading every byte anyway) — this one seems settled.
- For the verify job: full hash always — also settled.
- Sampled hashing (Spacedrive's model): is it worth the complexity? Tradeoff: much faster re-scans, but won't detect corruption in the non-sampled regions (only the verify job would catch that).
- Risk of mtime being wrong: macOS can have mtime-preserving copies, backups that restore old mtimes, etc. How much do we trust mtime as a change signal?

**Likely direction:** mtime+size for quick change detection during re-scans (rsync-style), full BLAKE3 when copying, full BLAKE3 in the verify job. Sampled hashing is probably overkill for v1.

---

## 4. Orphaned temp files — detection without deletion

**Context:**
- The atomic copy pattern writes to `filename.backup-tmp-<uuid>` before renaming to the final name.
- If the process crashes mid-copy, the temp file is left on the destination HDD.
- Auto-deleting temp files on resume would mean the tool can delete files — this violates the safety constraint (additive-only, no deletions).

**What we need to decide:**
- Surface orphaned temp files in the UI as a "review needed" item: show path, size, estimated source file. Let the user decide whether to delete manually.
- Or: don't clean them up at all — they're harmless (take space, never collide with real files due to the uuid suffix). Just log and ignore.
- Or: only allow deletion through an explicit "clean up orphaned temp files" UI action — never automatic.

**Likely direction:** surface in UI with a manual cleanup action. Never automatic. The tool has zero implicit deletion logic.
