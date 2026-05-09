import type { Database } from "bun:sqlite";
import { readDiskId } from "./identity";
import { markDiskConnected, markDiskDisconnected, getAllDisks } from "./registry";

const POLL_INTERVAL_MS = 5_000;

/**
 * Gets free/capacity bytes for a specific mount path using `df -Pk <path>`.
 * Returns nulls if the path isn't mounted or df fails.
 */
function getDiskStats(mountPath: string): { capacityBytes: number | null; freeBytes: number | null } {
  const proc = Bun.spawnSync(["df", "-Pk", mountPath], { stderr: "ignore" });
  if (proc.exitCode !== 0) return { capacityBytes: null, freeBytes: null };

  const lines = proc.stdout.toString().trim().split("\n");
  if (lines.length < 2) return { capacityBytes: null, freeBytes: null };

  const parts = lines[1].trim().split(/\s+/);
  if (parts.length < 4) return { capacityBytes: null, freeBytes: null };

  return {
    capacityBytes: Number(parts[1]) * 1024,
    freeBytes: Number(parts[3]) * 1024,
  };
}

/**
 * One poll cycle: for each registered disk, check whether its known mount path
 * still has the matching .waypoint-disk-id dotfile.
 *
 * If yes → markDiskConnected (updates free_bytes too).
 * If no  → markDiskDisconnected.
 *
 * No system-wide volume scanning. The server has no knowledge of volumes until
 * the user explicitly registers one.
 */
async function pollOnce(db: Database): Promise<void> {
  const disks = getAllDisks(db);

  await Promise.all(
    disks.map(async (disk) => {
      if (!disk.mount_path && !disk.is_connected) return; // never been connected, nothing to check

      // The path to check: last known mount_path if disconnected, or current mount_path if connected.
      // If disconnected and mount_path is null, we have no path to probe — skip.
      const probePath = disk.mount_path;
      if (!probePath) return;

      const uuid = await readDiskId(probePath).catch(() => null);
      const isPresent = uuid === disk.disk_uuid;

      if (isPresent) {
        const { capacityBytes, freeBytes } = getDiskStats(probePath);
        const changed =
          !disk.is_connected ||
          disk.free_bytes !== freeBytes;

        if (changed) {
          markDiskConnected(db, disk.disk_uuid, probePath, capacityBytes, freeBytes);
          if (!disk.is_connected) {
            console.log(`Disk connected: ${disk.label ?? disk.disk_uuid} at ${probePath}`);
          }
        }
      } else if (disk.is_connected) {
        markDiskDisconnected(db, disk.disk_uuid);
        console.log(`Disk disconnected: ${disk.label ?? disk.disk_uuid}`);
      }
    })
  );
}

/**
 * Starts the disk poller. Fires immediately, then every POLL_INTERVAL_MS.
 * Returns a cleanup function that stops polling.
 */
export function startDiskPoller(db: Database): () => void {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await pollOnce(db);
    } catch (err) {
      console.error("Disk poll error:", err);
    }
  };

  run();
  const timer = setInterval(run, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
