/**
 * Hardcoded path exclusions for the scan walker only.
 *
 * Unlike `excluded_paths` (the user-managed table), which marks a tree as
 * not-a-dedup-candidate while still indexing and copying it, entries here
 * tell the scan walker to skip the subtree entirely. Used for paths whose
 * contents cannot be read at all (e.g. the disk-3 `broken_paths/` quarantine
 * of ExFAT-corrupt directory entries — readdir lists them but stat/unlink
 * all return ENOENT).
 *
 * Matched as direct children of the disk's mount root only (no deep match),
 * so a legitimate sub-`broken_paths/` elsewhere in the tree is unaffected.
 */

const MOUNT_ROOT_NAMES = new Set([
  "broken_paths",
]);

/**
 * True if a subdirectory should be skipped at enqueue time.
 *
 * @param parentPath  absolute path of the directory currently being scanned
 * @param subdirName  basename of the subdirectory being considered
 * @param mountPath   absolute path of the disk's mount root
 */
export function isExcludedScanSubdir(
  parentPath: string,
  subdirName: string,
  mountPath: string,
): boolean {
  return parentPath === mountPath && MOUNT_ROOT_NAMES.has(subdirName);
}
