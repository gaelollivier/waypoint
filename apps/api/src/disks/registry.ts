import type { Database } from "bun:sqlite";

export interface DiskRow {
  id: number;
  disk_uuid: string;
  label: string | null;
  kind: "ssd" | "hdd";
  capacity_bytes: number | null;
  free_bytes: number | null;
  mount_path: string | null;
  is_connected: number; // 0 | 1
  last_seen_at: string | null;
  last_scan_job_id: number | null;
  last_scan_at: string | null;
  last_backup_job_id: number | null;
  last_backup_at: string | null;
  last_verify_job_id: number | null;
  last_verify_at: string | null;
}

/**
 * Registers a brand-new disk (after writing its dotfile).
 * Inserts a row and returns it.
 */
export function registerDisk(
  db: Database,
  opts: {
    diskUuid: string;
    label: string;
    kind: "ssd" | "hdd";
    mountPath: string;
    capacityBytes: number | null;
    freeBytes: number | null;
  }
): DiskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO disks
       (disk_uuid, label, kind, mount_path, capacity_bytes, free_bytes, is_connected, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    opts.diskUuid,
    opts.label,
    opts.kind,
    opts.mountPath,
    opts.capacityBytes,
    opts.freeBytes,
    now
  );
  return getDiskByUuid(db, opts.diskUuid)!;
}

/**
 * Called by the poller when a known disk (has dotfile + DB row) is seen connected.
 * Updates mount path, capacity, free space, and connection status.
 */
export function markDiskConnected(
  db: Database,
  diskUuid: string,
  mountPath: string,
  capacityBytes: number | null,
  freeBytes: number | null
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE disks
     SET is_connected = 1, mount_path = ?, capacity_bytes = ?, free_bytes = ?, last_seen_at = ?
     WHERE disk_uuid = ?`
  ).run(mountPath, capacityBytes, freeBytes, now, diskUuid);
}

/**
 * Called by the poller when a disk's UUID is no longer found among mounted volumes.
 */
export function markDiskDisconnected(db: Database, diskUuid: string): void {
  db.prepare(
    `UPDATE disks SET is_connected = 0, mount_path = NULL WHERE disk_uuid = ?`
  ).run(diskUuid);
}

/**
 * Update user-settable fields (label, kind).
 */
export function updateDisk(
  db: Database,
  id: number,
  fields: Partial<{ label: string; kind: "ssd" | "hdd" }>
): DiskRow | null {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (fields.label !== undefined) { sets.push("label = ?"); values.push(fields.label); }
  if (fields.kind !== undefined) { sets.push("kind = ?"); values.push(fields.kind); }
  if (sets.length === 0) return getDiskById(db, id);
  values.push(id);
  db.prepare(`UPDATE disks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getDiskById(db, id);
}

export function getAllDisks(db: Database): DiskRow[] {
  return db.prepare("SELECT * FROM disks ORDER BY id").all() as DiskRow[];
}

export function getDiskById(db: Database, id: number): DiskRow | null {
  return (db.prepare("SELECT * FROM disks WHERE id = ?").get(id) as DiskRow | null);
}

export function getDiskByUuid(db: Database, uuid: string): DiskRow | null {
  return (db.prepare("SELECT * FROM disks WHERE disk_uuid = ?").get(uuid) as DiskRow | null);
}
