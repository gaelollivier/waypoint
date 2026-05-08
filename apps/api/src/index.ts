import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getDb } from "./db/client";
import { startDiskPoller } from "./disks/poll";
import { initLockManager } from "./locks";
import { initJobManager } from "./jobs";
import { disksRouter } from "./routes/disks";
import { jobsRouter } from "./routes/jobs";
import { treeRouter } from "./routes/tree";
import { startLoopStallDetector, trace } from "./diag/trace";

// Initialize DB (runs migrations + clears stale locks) at startup
const db = getDb();

// Initialize lock manager (must come after DB so stale locks are already cleared)
initLockManager(db);

// Initialize job manager
initJobManager(db);

// Start disk poller (fires immediately, then every 10s)
startDiskPoller(db);

// Diagnostic: detect main-loop stalls so we can correlate freezes with the
// walker / flush traces.
startLoopStallDetector();
trace("api_start", { pid: process.pid });

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({ origin: "http://localhost:5173", credentials: true })
);

app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/api/disks", disksRouter);
app.route("/api/jobs", jobsRouter);
app.route("/api/disks/:id/tree", treeRouter);

const PORT = Number(process.env.PORT ?? 3000);

console.log(`Waypoint API listening on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
