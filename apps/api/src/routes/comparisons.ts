import { Hono } from "hono";
import { getDb } from "../db/client";

// ---------------------------------------------------------------------------
// Media comparison batches.
//
// A batch holds an ordered list of (left, right) media pairs. The reviewer
// (user) opens the batch in the UI, walks through the pairs, and verdicts
// each as `same`, `different`, or `unsure`. Cross-disk pairs are allowed
// because the goal here is to compare a Google_Backup file against its
// candidate counterpart in another tree (potentially on the same disk or on
// a different disk).
//
// Read-only with respect to the user's data — verdicts are stored in
// SQLite alongside the pair metadata. Nothing here deletes files; verdicts
// just inform later cleanup decisions.
// ---------------------------------------------------------------------------

export const comparisonsRouter = new Hono();

type Verdict = "same" | "different" | "unsure";

interface BatchRow {
  id: number;
  name: string;
  rationale: string;
  created_at: string;
}

interface MemberRow {
  id: number;
  batch_id: number;
  position: number;
  left_path: string;
  left_size_bytes: number | null;
  left_content_hash: string | null;
  right_path: string;
  right_size_bytes: number | null;
  right_content_hash: string | null;
  note: string;
  verdict: Verdict | null;
  verdict_note: string;
  verdicted_at: string | null;
}

function formatMember(m: MemberRow) {
  return {
    id: m.id,
    batchId: m.batch_id,
    position: m.position,
    left: {
      path: m.left_path,
      sizeBytes: m.left_size_bytes,
      contentHash: m.left_content_hash,
    },
    right: {
      path: m.right_path,
      sizeBytes: m.right_size_bytes,
      contentHash: m.right_content_hash,
    },
    note: m.note,
    verdict: m.verdict,
    verdictNote: m.verdict_note,
    verdictedAt: m.verdicted_at,
  };
}

function progressFor(db: ReturnType<typeof getDb>, batchId: number) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN verdict IS NULL        THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN verdict = 'same'      THEN 1 ELSE 0 END) AS same,
         SUM(CASE WHEN verdict = 'different' THEN 1 ELSE 0 END) AS different,
         SUM(CASE WHEN verdict = 'unsure'    THEN 1 ELSE 0 END) AS unsure
       FROM comparison_members WHERE batch_id = ?`
    )
    .get(batchId) as {
      total: number;
      pending: number | null;
      same: number | null;
      different: number | null;
      unsure: number | null;
    };
  return {
    total: row.total,
    pending: row.pending ?? 0,
    same: row.same ?? 0,
    different: row.different ?? 0,
    unsure: row.unsure ?? 0,
  };
}

// ---------------------------------------------------------------------------
// GET /api/comparisons  — list batches, newest first
// ---------------------------------------------------------------------------
comparisonsRouter.get("/", (c) => {
  const db = getDb();
  const batches = db
    .prepare(
      `SELECT id, name, rationale, created_at
       FROM comparison_batches
       ORDER BY id DESC`
    )
    .all() as BatchRow[];

  const result = batches.map((b) => ({
    id: b.id,
    name: b.name,
    rationale: b.rationale,
    createdAt: b.created_at,
    progress: progressFor(db, b.id),
  }));

  return c.json({ batches: result });
});

// ---------------------------------------------------------------------------
// GET /api/comparisons/:batchId  — one batch with all members
// ---------------------------------------------------------------------------
comparisonsRouter.get("/:batchId", (c) => {
  const batchId = Number(c.req.param("batchId"));
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return c.json({ error: "Invalid batchId" }, 400);
  }

  const db = getDb();
  const batch = db
    .prepare(`SELECT id, name, rationale, created_at FROM comparison_batches WHERE id = ?`)
    .get(batchId) as BatchRow | null;
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  const members = db
    .prepare(
      `SELECT id, batch_id, position, left_path, left_size_bytes, left_content_hash,
              right_path, right_size_bytes, right_content_hash,
              note, verdict, verdict_note, verdicted_at
       FROM comparison_members
       WHERE batch_id = ?
       ORDER BY position, id`
    )
    .all(batchId) as MemberRow[];

  return c.json({
    id: batch.id,
    name: batch.name,
    rationale: batch.rationale,
    createdAt: batch.created_at,
    progress: progressFor(db, batch.id),
    members: members.map(formatMember),
  });
});

// ---------------------------------------------------------------------------
// POST /api/comparisons
//   body: {
//     name: string,
//     rationale?: string,
//     members: [
//       { leftPath, leftSizeBytes?, leftContentHash?,
//         rightPath, rightSizeBytes?, rightContentHash?,
//         note? }
//     ]
//   }
//
// Member `position` is assigned by array order (0-indexed).
// ---------------------------------------------------------------------------
interface CreateMemberInput {
  leftPath: string;
  leftSizeBytes?: number | null;
  leftContentHash?: string | null;
  rightPath: string;
  rightSizeBytes?: number | null;
  rightContentHash?: string | null;
  note?: string;
}
interface CreateBatchBody {
  name?: unknown;
  rationale?: unknown;
  members?: unknown;
}

function validateMember(m: unknown, index: number): string | CreateMemberInput {
  if (typeof m !== "object" || m === null) {
    return `member ${index} must be an object`;
  }
  const mm = m as Record<string, unknown>;
  if (typeof mm.leftPath !== "string" || !mm.leftPath.startsWith("/")) {
    return `member ${index}: leftPath must be an absolute path`;
  }
  if (typeof mm.rightPath !== "string" || !mm.rightPath.startsWith("/")) {
    return `member ${index}: rightPath must be an absolute path`;
  }
  if (mm.leftPath === mm.rightPath) {
    return `member ${index}: leftPath and rightPath must differ`;
  }
  const optionalString = (v: unknown, name: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return `member ${index}: ${name} must be a string`;
    return v;
  };
  const optionalSize = (v: unknown, name: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `member ${index}: ${name} must be a non-negative number`;
    }
    return Math.floor(v);
  };
  const lh = optionalString(mm.leftContentHash, "leftContentHash");
  if (typeof lh === "string" && lh.startsWith("member")) return lh;
  const rh = optionalString(mm.rightContentHash, "rightContentHash");
  if (typeof rh === "string" && rh.startsWith("member")) return rh;
  const note = optionalString(mm.note, "note");
  if (typeof note === "string" && note.startsWith("member")) return note;

  const ls = optionalSize(mm.leftSizeBytes, "leftSizeBytes");
  if (typeof ls === "string") return ls;
  const rs = optionalSize(mm.rightSizeBytes, "rightSizeBytes");
  if (typeof rs === "string") return rs;

  return {
    leftPath: mm.leftPath,
    leftSizeBytes: ls,
    leftContentHash: lh as string | null,
    rightPath: mm.rightPath,
    rightSizeBytes: rs,
    rightContentHash: rh as string | null,
    note: note as string | null ?? "",
  };
}

comparisonsRouter.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json<CreateBatchBody>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : "";
  if (!Array.isArray(body.members) || body.members.length === 0) {
    return c.json({ error: "members must be a non-empty array" }, 400);
  }

  const validated: CreateMemberInput[] = [];
  for (let i = 0; i < body.members.length; i++) {
    const v = validateMember(body.members[i], i);
    if (typeof v === "string") return c.json({ error: v }, 400);
    validated.push(v);
  }

  const batchId = db.transaction(() => {
    const parent = db
      .prepare(
        `INSERT INTO comparison_batches (name, rationale) VALUES (?, ?) RETURNING id`
      )
      .get(body.name as string, rationale) as { id: number };

    const insertMember = db.prepare(
      `INSERT INTO comparison_members
         (batch_id, position, left_path, left_size_bytes, left_content_hash,
          right_path, right_size_bytes, right_content_hash, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < validated.length; i++) {
      const m = validated[i];
      insertMember.run(
        parent.id,
        i,
        m.leftPath,
        m.leftSizeBytes ?? null,
        m.leftContentHash ?? null,
        m.rightPath,
        m.rightSizeBytes ?? null,
        m.rightContentHash ?? null,
        m.note ?? ""
      );
    }
    return parent.id;
  })();

  return c.json({ id: batchId }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/comparisons/:batchId  — delete a whole batch (members cascade).
// ---------------------------------------------------------------------------
comparisonsRouter.delete("/:batchId", (c) => {
  const batchId = Number(c.req.param("batchId"));
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return c.json({ error: "Invalid batchId" }, 400);
  }

  const db = getDb();
  const result = db.prepare(`DELETE FROM comparison_batches WHERE id = ?`).run(batchId);
  if (result.changes === 0) return c.json({ error: "Batch not found" }, 404);
  return c.json({ id: batchId, deleted: true });
});

// ---------------------------------------------------------------------------
// POST /api/comparisons/:batchId/members/:memberId/verdict
//   body: { verdict: 'same'|'different'|'unsure'|null, note?: string }
//
// A null verdict resets the row back to pending.
// ---------------------------------------------------------------------------
comparisonsRouter.post("/:batchId/members/:memberId/verdict", async (c) => {
  const batchId = Number(c.req.param("batchId"));
  const memberId = Number(c.req.param("memberId"));
  if (!Number.isInteger(batchId) || batchId <= 0) return c.json({ error: "Invalid batchId" }, 400);
  if (!Number.isInteger(memberId) || memberId <= 0) return c.json({ error: "Invalid memberId" }, 400);

  const body = await c.req.json<{ verdict?: unknown; note?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const verdict =
    body.verdict === null || body.verdict === undefined
      ? null
      : (body.verdict as string);
  if (verdict !== null && !["same", "different", "unsure"].includes(verdict)) {
    return c.json({ error: "verdict must be 'same' | 'different' | 'unsure' | null" }, 400);
  }
  const note = typeof body.note === "string" ? body.note : "";

  const db = getDb();
  const member = db
    .prepare(`SELECT id, batch_id FROM comparison_members WHERE id = ?`)
    .get(memberId) as { id: number; batch_id: number } | null;
  if (!member) return c.json({ error: "Member not found" }, 404);
  if (member.batch_id !== batchId) return c.json({ error: "Member does not belong to this batch" }, 404);

  const verdictedAt = verdict === null ? null : new Date().toISOString();
  db.prepare(
    `UPDATE comparison_members
       SET verdict = ?, verdict_note = ?, verdicted_at = ?
     WHERE id = ?`
  ).run(verdict, note, verdictedAt, memberId);

  const row = db
    .prepare(
      `SELECT id, batch_id, position, left_path, left_size_bytes, left_content_hash,
              right_path, right_size_bytes, right_content_hash,
              note, verdict, verdict_note, verdicted_at
       FROM comparison_members WHERE id = ?`
    )
    .get(memberId) as MemberRow;

  return c.json(formatMember(row));
});
