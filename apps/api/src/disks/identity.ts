import path from "path";
import { fileExists, readTextFile, writeTextFile } from "../fs/disk-io";

const DISK_ID_FILENAME = ".waypoint-disk-id";

/**
 * Reads the Waypoint UUID from a disk's root. Returns null if not present.
 */
export async function readDiskId(mountPath: string): Promise<string | null> {
  const dotfilePath = path.join(mountPath, DISK_ID_FILENAME);
  if (!(await fileExists(dotfilePath))) return null;
  const text = (await readTextFile(dotfilePath)).trim();
  return text.length > 0 ? text : null;
}

/**
 * Writes a new UUID to a disk's root dotfile. Returns the UUID written.
 * Throws if the disk is not writable.
 */
export async function writeDiskId(mountPath: string): Promise<string> {
  const uuid = crypto.randomUUID();
  const dotfilePath = path.join(mountPath, DISK_ID_FILENAME);
  await writeTextFile(dotfilePath, uuid + "\n");
  return uuid;
}

/**
 * Reads existing UUID or creates one if the dotfile doesn't exist yet.
 */
export async function ensureDiskId(mountPath: string): Promise<string> {
  const existing = await readDiskId(mountPath);
  if (existing) return existing;
  return writeDiskId(mountPath);
}
