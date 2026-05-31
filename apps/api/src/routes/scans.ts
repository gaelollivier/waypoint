import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";

export const scansRouter = new Hono();

export interface ScanSummary {
  id: number;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  fileCount: number;
  totalSizeBytes: number;
  sampledHashCount: number;
  fullHashCount: number;
  requestedFullHash: boolean;
}

export interface ScansResponse {
  diskId: number;
  latestScanId: number | null;
  scans: ScanSummary[];
}

/**
 * GET /api/disks/:id/scans
 *
 * List every scan job for this disk (any status), newest first. Also reports
 * the disk's `last_scan_job_id` so callers can quickly find the snapshot the
 * rest of the API defaults to. Distinct from /duplicates/scans, which is a
 * cleanup-eligibility view restricted to completed scans with hash data.
 */
scansRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const rows = db
    .prepare(
      `SELECT j.id,
              j.status,
              j.created_at,
              j.started_at,
              j.completed_at,
              COALESCE(json_extract(j.payload_json, '$.fullHash'), 0) AS requested_full_hash,
              (SELECT COUNT(*) FROM files f WHERE f.scan_id = j.id) AS file_count,
              (SELECT COALESCE(SUM(size_bytes), 0) FROM files f WHERE f.scan_id = j.id) AS total_size_bytes,
              (SELECT COUNT(sampled_hash) FROM files f WHERE f.scan_id = j.id) AS sampled_hash_count,
              (SELECT COUNT(full_hash) FROM files f WHERE f.scan_id = j.id) AS full_hash_count
         FROM jobs j
        WHERE j.type = 'scan'
          AND j.target_disk_id = ?
        ORDER BY j.id DESC`
    )
    .all(diskId) as Array<{
      id: number;
      status: string;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      requested_full_hash: number;
      file_count: number;
      total_size_bytes: number;
      sampled_hash_count: number;
      full_hash_count: number;
    }>;

  const body: ScansResponse = {
    diskId,
    latestScanId: disk.last_scan_job_id ?? null,
    scans: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      fileCount: r.file_count,
      totalSizeBytes: r.total_size_bytes,
      sampledHashCount: r.sampled_hash_count,
      fullHashCount: r.full_hash_count,
      requestedFullHash: r.requested_full_hash === 1,
    })),
  };
  return c.json(body);
});
