/**
 * macOS-specific kind auto-detection. Reads `diskutil info <mountPath>` and
 * looks for `Solid State: Yes/No`. Falls back to "hdd" on any failure (more
 * conservative for I/O concurrency tuning).
 */
export async function detectDiskKind(mountPath: string): Promise<"ssd" | "hdd"> {
  try {
    const proc = Bun.spawnSync(["diskutil", "info", mountPath], { stderr: "ignore" });
    if (proc.exitCode !== 0) return "hdd";
    const out = proc.stdout.toString();
    const match = out.match(/Solid State:\s*(Yes|No)/i);
    if (match) return match[1].toLowerCase() === "yes" ? "ssd" : "hdd";
    return "hdd";
  } catch {
    return "hdd";
  }
}

/**
 * Lists currently mounted volumes under /Volumes that aren't the system root.
 * Used by the registration UI's volume picker. Returns the mount paths the user
 * can register.
 */
export async function listAvailableVolumes(): Promise<Array<{
  mountPath: string;
  name: string;
  capacityBytes: number | null;
  freeBytes: number | null;
  isWaypointDisk: boolean;
}>> {
  const { readdir } = await import("fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir("/Volumes");
  } catch {
    return [];
  }

  const path = await import("path");
  const results: Array<{
    mountPath: string;
    name: string;
    capacityBytes: number | null;
    freeBytes: number | null;
    isWaypointDisk: boolean;
  }> = [];

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const mountPath = path.join("/Volumes", name);
    const stats = getDiskStats(mountPath);
    const isWaypointDisk = await Bun.file(path.join(mountPath, ".waypoint-disk-id")).exists();
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
