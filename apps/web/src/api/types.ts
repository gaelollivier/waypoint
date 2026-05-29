export interface Disk {
  id: number;
  diskUuid: string;
  label: string | null;
  kind: "ssd" | "hdd";
  capacityBytes: number | null;
  freeBytes: number | null;
  mountPath: string | null;
  isConnected: boolean;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  lastBackupAt: string | null;
  lastVerifyAt: string | null;
}

export type DiffKind = "added" | "changed" | "removed" | "present";

export interface DiffEntry {
  kind: "directory" | "file";
  name: string;
  path: string;
  sizeBytes: number;
  // files only
  diffKind?: DiffKind;
  sourceSizeBytes?: number | null;
  destSizeBytes?: number | null;
  // directories only
  addedCount?: number;
  addedBytes?: number;
  changedCount?: number;
  changedBytes?: number;
  removedCount?: number;
  removedBytes?: number;
  presentCount?: number;
  presentBytes?: number;
}

export interface DiffTreeResponse {
  diffJobId: number;
  sourceDiskId: number;
  destDiskId: number;
  parentPath: string;
  sourceCurrentPath: string | null;
  destCurrentPath: string | null;
  breadcrumb: Array<{ name: string; path: string | null }>;
  totalAdded: number;
  totalAddedBytes: number;
  totalChanged: number;
  totalChangedBytes: number;
  totalRemoved: number;
  totalRemovedBytes: number;
  totalPresent: number;
  totalPresentBytes: number;
  currentDir: {
    addedCount: number; addedBytes: number;
    changedCount: number; changedBytes: number;
    removedCount: number; removedBytes: number;
    presentCount: number; presentBytes: number;
  };
  entries: DiffEntry[];
}

export interface DiffJobSummary {
  id: number;
  status: Job["status"];
  sourceDiskId: number;
  destDiskId: number;
  destLabel: string | null;
  itemsProcessed: number;
  createdAt: string;
  completedAt: string | null;
}

export interface DuplicateGroupFile {
  fileId: number;
  path: string;
  deletedAt: string | null;
}

export interface DuplicateGroup {
  id: number;
  hashKind: "full" | "sampled";
  contentHash: string;
  sampledHash: string;
  canDelete: boolean;
  fileCount: number;
  sizeBytes: number;
  wastedBytes: number;
  files: DuplicateGroupFile[];
}

export interface DuplicatesResponse {
  duplicateJobId: number;
  diskId: number;
  totalGroups: number;
  totalWastedBytes: number;
  groups: DuplicateGroup[];
}

export interface CleanupResult {
  fileId: number;
  path: string;
  status: "deleted";
}

export interface CleanupResponse {
  duplicateGroupId: number;
  keepFileId: number;
  deletedCount: number;
  results: CleanupResult[];
}

/** Returned in the 500 response body when a cleanup halts mid-way. */
export interface CleanupHaltedBody {
  error: string;
  duplicateGroupId: number;
  keepFileId: number;
  deletedCount: number;
  results: CleanupResult[];
  failedAt: { fileId: number; path: string; error: string };
}

export interface DuplicateDirectoryGroupMember {
  directoryId: number;
  path: string;
  deletedAt: string | null;
}

export interface DuplicateDirectoryGroup {
  id: number;
  contentHash: string;
  directoryCount: number;
  fileCount: number;
  totalSizeBytes: number;
  wastedBytes: number;
  /** True iff every descendant file across every member directory has full_hash. */
  canDelete: boolean;
  directories: DuplicateDirectoryGroupMember[];
}

/** File belonging to a member directory of a directory duplicate group. */
export interface DirectoryGroupMemberFile {
  fileId: number;
  path: string;
  relativePath: string;
  sizeBytes: number;
  hasFullHash: boolean;
}

/** Per-member-directory file list for the cleanup confirmation dialog. */
export interface DirectoryGroupFilesResponse {
  groupId: number;
  canDelete: boolean;
  members: Array<{
    directoryId: number;
    path: string;
    files: DirectoryGroupMemberFile[];
  }>;
}

/** A file currently on disk inside a member directory. */
export interface InventoryFile {
  relativePath: string;
  sizeBytes: number;
}

/** A file the scan recorded but that is currently missing from disk. */
export interface InventoryMissingFile {
  fileId: number;
  relativePath: string;
}

/** Scanned files include the DB id and full-hash availability flag. */
export interface InventoryScannedFile extends InventoryFile {
  fileId: number;
  hasFullHash: boolean;
}

/**
 * Per-member-directory live inventory. The dialog uses this to show the user
 * every file they're about to delete (including OS noise files that the scan
 * intentionally never indexed) and to block confirmation when an unknown
 * file is on disk inside a delete folder.
 */
export interface DirectoryGroupInventoryMember {
  directoryId: number;
  path: string;
  /** False when the directory has been removed from disk since the scan. */
  directoryExists: boolean;
  /** Files matching the scan record by relative path. */
  scanned: InventoryScannedFile[];
  /** Files matching the noise-file allowlist (.DS_Store, ._*, .waypoint-disk-id). */
  excluded: InventoryFile[];
  /** Files present on disk that are neither scanned nor on the noise allowlist. */
  unknown: InventoryFile[];
  /** Files the scan recorded but that are missing from disk right now. */
  missing: InventoryMissingFile[];
}

export interface DirectoryGroupInventoryResponse {
  groupId: number;
  /** Same eligibility flag as the corresponding directory group. */
  canDelete: boolean;
  members: DirectoryGroupInventoryMember[];
}

export interface DuplicateDirectoriesResponse {
  duplicateJobId: number;
  diskId: number;
  totalGroups: number;
  totalWastedBytes: number;
  totalFileCount: number;
  groups: DuplicateDirectoryGroup[];
}

export interface DuplicateJobSummary {
  id: number;
  status: Job["status"];
  diskId: number;
  scanId: number | null;
  itemsProcessed: number;
  createdAt: string;
  completedAt: string | null;
}

export interface DuplicateScanSummary {
  id: number;
  createdAt: string;
  completedAt: string | null;
  requestedFullHash: boolean;
  fileCount: number;
  sampledHashCount: number;
  fullHashCount: number;
  hasAnyFullHashes: boolean;
  hasAllFullHashes: boolean;
}

export interface Job {
  id: number;
  type:
    | "scan"
    | "copy"
    | "verify"
    | "backup"
    | "diff"
    | "duplicate_detection"
    | "directory_duplicate_cleanup"
    | "write_speed_test"
    | "read_speed_test";
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: string | null;
  parentJobId: number | null;
  targetDiskId: number | null;
  sourceDiskId: number | null;
  destDiskId: number | null;
  bytesProcessed: number;
  itemsProcessed: number;
  warningsCount: number;
  nonCriticalErrorsCount: number;
  errorsCount: number;
  progressJson: Record<string, unknown> | null;
  createdBy: "user" | "composite";
  createdAt: string;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface TreeEntry {
  kind: "directory" | "file";
  id: number;
  name: string;
  path: string;
  sizeBytes: number;
  fileCount?: number;
  directFileCount?: number;
  mtime?: string;
  sampledHash?: string | null;
}

export interface TreeResponse {
  diskId: number;
  parentId: number | null;
  parentPath: string | null;
  breadcrumb: Array<{ id: number | null; name: string; path: string }>;
  totalSizeBytes: number;
  entries: TreeEntry[];
}

export interface JobEvent {
  id: number;
  jobId: number;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: string;
  message: string;
  payloadJson: string | null;
}

// ── Agent-driven cleanup ────────────────────────────────────────────────────

export interface AgentNotes {
  diskId: number;
  body: string;
  updatedAt: string | null;
}

export interface DeletionHistoryEvent {
  deletedAt: string;
  scanId: number;
  deletedPath: string;
  sizeBytes: number;
  contentHash: string | null;
  sampledHash: string | null;
  siblingPaths: string[];
}

export interface DeletionHistoryResponse {
  diskId: number;
  total: number;
  limit: number;
  offset: number;
  events: DeletionHistoryEvent[];
}

interface CleanupSuggestionMemberBase {
  id: number;
  contentHash: string;
  keepPath: string;
  deletePaths: string[];
  sizeBytes: number;
  wastedBytes: number;
}

export interface ResolvedSuggestionMember extends CleanupSuggestionMemberBase {
  resolved: true;
  duplicateGroupId: number;
  keepFile: { fileId: number; path: string };
  deleteFiles: Array<{ fileId: number; path: string }>;
}

export interface StaleSuggestionMember extends CleanupSuggestionMemberBase {
  resolved: false;
  staleReason: string | null;
}

export type CleanupSuggestionMember = ResolvedSuggestionMember | StaleSuggestionMember;

/**
 * A "suggestion" is a batch of one or more members. Singleton batches still
 * render as one card; multi-member batches render members under a shared
 * prefix and apply atomically through one server-side call.
 */
export interface CleanupSuggestion {
  id: number;
  status: "pending" | "applied" | "dismissed";
  rationale: string;
  batchKey: string | null;
  createdAt: string;
  appliedAt: string | null;
  dismissedAt: string | null;
  memberCount: number;
  totalSizeBytes: number;
  totalWastedBytes: number;
  /** True when every member resolves and the batch is `pending`. */
  allResolved: boolean;
  members: CleanupSuggestionMember[];
}

export interface CleanupSuggestionsResponse {
  diskId: number;
  duplicateJobId: number | null;
  total: number;
  limit: number;
  offset: number;
  suggestions: CleanupSuggestion[];
}

export interface CleanupApplyMemberResult {
  memberId: number;
  duplicateGroupId: number;
  keepFileId: number;
  deletedCount: number;
  results: Array<{ fileId: number; path: string; status: "deleted" }>;
  failedAt: { fileId: number; path: string; error: string } | null;
}

export interface CleanupApplyResponse {
  suggestionId: number;
  status: "applied";
  appliedAt: string;
  totalDeleted: number;
  members: CleanupApplyMemberResult[];
}

// ── Per-disk exclusion list (duplicate detection only) ─────────────────────

export interface ExcludedPath {
  id: number;
  diskId: number;
  path: string;
  reason: string;
  createdAt: string;
}

export interface ExcludedPathsResponse {
  diskId: number;
  exclusions: ExcludedPath[];
}

// ── Media comparison batches ───────────────────────────────────────────────

export type ComparisonVerdict = "same" | "different" | "unsure";

export interface ComparisonProgress {
  total: number;
  pending: number;
  same: number;
  different: number;
  unsure: number;
}

export interface ComparisonSide {
  path: string;
  sizeBytes: number | null;
  contentHash: string | null;
}

export interface ComparisonMember {
  id: number;
  batchId: number;
  position: number;
  left: ComparisonSide;
  right: ComparisonSide;
  note: string;
  verdict: ComparisonVerdict | null;
  verdictNote: string;
  verdictedAt: string | null;
}

export interface ComparisonBatchSummary {
  id: number;
  name: string;
  rationale: string;
  createdAt: string;
  progress: ComparisonProgress;
}

export interface ComparisonBatchDetail extends ComparisonBatchSummary {
  members: ComparisonMember[];
}
