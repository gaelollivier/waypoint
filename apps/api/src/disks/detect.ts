import path from "path";
import {
  listVolumes,
  getDiskStats,
  detectDiskKind,
  fileExists,
} from "../fs/disk-io";

export { detectDiskKind };

/**
 * Lists currently mounted volumes under /Volumes that aren't the system root.
 * Used by the registration UI's volume picker. Returns the mount paths the user
 * can register.
 */
export async function listAvailableVolumes(): Promise<
  Array<{
    mountPath: string;
    name: string;
    capacityBytes: number | null;
    freeBytes: number | null;
    isWaypointDisk: boolean;
  }>
> {
  const names = await listVolumes();
  const results: Array<{
    mountPath: string;
    name: string;
    capacityBytes: number | null;
    freeBytes: number | null;
    isWaypointDisk: boolean;
  }> = [];

  for (const name of names) {
    const mountPath = path.join("/Volumes", name);
    const stats = getDiskStats(mountPath);
    const isWaypointDisk = await fileExists(
      path.join(mountPath, ".waypoint-disk-id")
    );
    results.push({
      mountPath,
      name,
      capacityBytes: stats.capacityBytes,
      freeBytes: stats.freeBytes,
      isWaypointDisk,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
