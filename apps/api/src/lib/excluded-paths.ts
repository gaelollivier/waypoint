/**
 * SQL fragment that excludes files at or under any path in the
 * `excluded_paths` table for the given disk.
 *
 * The fragment expects:
 *   - `files` (table name) accessible in the surrounding query, with `path`
 *     and `disk_id` columns (the actual `files` table is fine; do not alias).
 *   - One bound parameter `?` for the disk id, placed wherever this fragment
 *     appears in the query.
 *
 * Match semantics: exact path OR descendant (`files.path = e.path OR
 * files.path LIKE e.path || '/%'`). Excluding a directory excludes every
 * file at or under it; excluding a single file path only matches that file.
 *
 * NOT EXISTS keeps the surrounding query sargable on the partial hash
 * indexes used by duplicate detection (e.g. `files_scan_full_hash_size`).
 * The `excluded_paths` table is expected to be tiny in practice (a handful
 * to a couple dozen entries per disk).
 *
 * Applied to duplicate detection ONLY. Scan, diff, and copy intentionally
 * ignore the exclusion list (the file is still indexed and still copied;
 * we just don't surface it as a duplicate-detection candidate).
 */
export const EXCLUDED_PATHS_SQL = `
  NOT EXISTS (
    SELECT 1 FROM excluded_paths e
    WHERE e.disk_id = ?
      AND (files.path = e.path OR files.path LIKE e.path || '/%')
  )
`;
