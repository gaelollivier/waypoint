-- Promote `cleanup_suggestions` from "one row per content_hash" into a
-- parent batch + member-row pair. A "suggestion" is now a group of one or
-- more (content_hash, keep_path, delete_paths) members that the user can
-- accept or reject as a single unit.
--
-- Why a proper primitive: the agent frequently identifies the same
-- keep/delete intent across many sibling files in the same folder pair
-- (e.g. "delete every file under <backup folder> that already lives under
-- <source folder>"). Emitting one suggestion per file forces the user to
-- click through N cards for what is conceptually one decision. Batching at
-- the schema level lets the UI render one card, lets the agent express
-- intent ("this group of N files is one rule"), and lets the server apply
-- the whole batch under a single disk write lock with one freshness check.
--
-- The path-keyed resolution semantics are preserved: each MEMBER still
-- carries `content_hash + keep_path + delete_paths` and is independently
-- resolved against the latest duplicate detection at read time. A batch
-- with N members can report `resolved: true` for some and `resolved: false`
-- for others — the UI surfaces this and the apply endpoint refuses if any
-- member is stale.

-- Step 1: Drop v1 indexes so we can repurpose the table name.
DROP INDEX IF EXISTS cleanup_suggestions_list;
DROP INDEX IF EXISTS cleanup_suggestions_pending_uniq;

-- Step 2: Rename the v1 table out of the way. We'll copy from it then drop.
ALTER TABLE cleanup_suggestions RENAME TO cleanup_suggestions_v1;

-- Step 3: New parent table. `batch_key` lets the agent re-post with stable
-- identity (e.g. a folder-pair key) and have the new payload replace the
-- previous pending batch — generalizing the v1 `content_hash`-keyed replace.
CREATE TABLE cleanup_suggestions (
  id           INTEGER PRIMARY KEY,
  disk_id      INTEGER NOT NULL REFERENCES disks(id),
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'dismissed')),
  rationale    TEXT    NOT NULL DEFAULT '',
  batch_key    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  applied_at   TEXT,
  dismissed_at TEXT
);

CREATE INDEX cleanup_suggestions_list
  ON cleanup_suggestions (disk_id, status);

-- One pending batch per (disk, batch_key) when batch_key is set. NULL is
-- not constrained (multiple un-tagged batches can coexist).
CREATE UNIQUE INDEX cleanup_suggestions_batch_key_pending_uniq
  ON cleanup_suggestions (disk_id, batch_key)
  WHERE status = 'pending' AND batch_key IS NOT NULL;

-- Step 4: New per-member table. Each row is one (content_hash, keep_path,
-- delete_paths) triple, resolved independently against the latest
-- duplicate detection. Members within a single batch are ordered for
-- stable UI rendering by their auto-incrementing id.
CREATE TABLE cleanup_suggestion_members (
  id             INTEGER PRIMARY KEY,
  suggestion_id  INTEGER NOT NULL REFERENCES cleanup_suggestions(id) ON DELETE CASCADE,
  content_hash   TEXT    NOT NULL,
  keep_path      TEXT    NOT NULL,
  delete_paths   TEXT    NOT NULL,                   -- JSON array of absolute paths
  size_bytes     INTEGER NOT NULL
);

CREATE INDEX cleanup_suggestion_members_by_suggestion
  ON cleanup_suggestion_members (suggestion_id);

-- Two members in different *pending* batches can technically reference the
-- same content_hash; the apply endpoint resolves each member at run time and
-- treats the second one as stale if the first already deleted the file. The
-- partial unique index below catches the more interesting case: same
-- content_hash twice WITHIN a single pending batch, which is always a bug.
CREATE UNIQUE INDEX cleanup_suggestion_members_uniq_within_batch
  ON cleanup_suggestion_members (suggestion_id, content_hash);

-- Step 5: Migrate v1 rows. Each old row becomes a singleton batch — same
-- id (so any URLs the user has bookmarked still resolve), same status,
-- same timestamps, NULL batch_key. The member carries the content_hash
-- and paths.
INSERT INTO cleanup_suggestions (id, disk_id, status, rationale, batch_key, created_at, applied_at, dismissed_at)
SELECT id, disk_id, status, rationale, NULL, created_at, applied_at, dismissed_at
FROM cleanup_suggestions_v1;

INSERT INTO cleanup_suggestion_members (suggestion_id, content_hash, keep_path, delete_paths, size_bytes)
SELECT id, content_hash, keep_path, delete_paths, size_bytes
FROM cleanup_suggestions_v1;

DROP TABLE cleanup_suggestions_v1;
