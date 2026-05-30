import type { Database } from "bun:sqlite";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import type { ExtractedMetadata } from "./extractor";
import { classifyByExtension } from "./extractor";

const CHUNK_SIZE = 200;

interface FileTarget {
  fileId: number;
  path: string;
  name: string;
}

interface MediaMetadataProgress {
  filesTotal: number;
  filesCompleted: number;
  withDatetime: number;
  errors: number;
  scanId: number;
  pathPrefix: string | null;
}

/**
 * Extracts EXIF / QuickTime metadata for media files belonging to a given
 * scan. For each file:
 *   - image extensions go through `exifr` (in a worker thread),
 *   - video extensions go through `ffprobe`,
 *   - unsupported extensions are recorded with an `unsupported_extension`
 *     marker so the loop won't retry on subsequent runs.
 *
 * Already-extracted files (rows present in `media_metadata` for that
 * `file_id`) are skipped. Re-extraction is therefore opt-in via deleting
 * the existing rows, not a job parameter — that keeps the job idempotent
 * and resumable.
 */
export class MediaMetadataJobRunner extends JobRunner {
  private db: Database;
  private diskId: number;
  private scanId: number;
  private pathPrefix: string | null;
  private worker: Worker | null = null;
  private progress: MediaMetadataProgress;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
    scanId: number;
    pathPrefix?: string | null;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.diskId = opts.diskId;
    this.scanId = opts.scanId;
    this.pathPrefix = opts.pathPrefix ?? null;
    this.progress = {
      filesTotal: 0,
      filesCompleted: 0,
      withDatetime: 0,
      errors: 0,
      scanId: this.scanId,
      pathPrefix: this.pathPrefix,
    };
  }

  override pause(): void {
    this.worker?.postMessage({ type: "pause" });
    super.pause();
  }

  override resume(): void {
    super.resume();
    this.worker?.postMessage({ type: "resume" });
  }

  override cancel(): void {
    this.worker?.postMessage({ type: "cancel" });
    super.cancel();
  }

  protected async execute(): Promise<void> {
    const files = this.findCandidates();
    this.progress.filesTotal = files.length;
    this.broadcast();

    if (files.length === 0) {
      this.logEvent("info", "no_files", "No supported media files needing extraction.");
      return;
    }

    this.logEvent(
      "info",
      "progress_milestone",
      `Media metadata extraction: ${files.length} files to process`
    );

    // Process in chunks so we can interleave DB writes and checkpoint
    // checks. The worker itself handles one chunk at a time.
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      await this.checkPause();
      const chunk = files.slice(i, i + CHUNK_SIZE);
      await this.runChunk(chunk);
    }

    this.logEvent(
      "info",
      "progress_milestone",
      `Extracted metadata for ${this.progress.filesCompleted} files ` +
        `(${this.progress.withDatetime} with datetime, ${this.progress.errors} errors).`
    );
  }

  /**
   * Returns files belonging to the requested scan that have a supported
   * extension and no existing media_metadata row. Bounded by scan_id, the
   * optional path prefix, and explicit extension filtering (so we don't even
   * enqueue files that the extractor would mark unsupported).
   */
  private findCandidates(): FileTarget[] {
    const params: (string | number)[] = [this.scanId];
    let pathClause = "";
    if (this.pathPrefix) {
      pathClause = "AND f.path LIKE ?";
      params.push(this.pathPrefix + "%");
    }

    const rows = this.db
      .prepare(
        `SELECT f.id AS fileId, f.path, f.name
         FROM files f
         LEFT JOIN media_metadata mm ON mm.file_id = f.id
         WHERE f.scan_id = ?
           ${pathClause}
           AND mm.file_id IS NULL`
      )
      .all(...params) as Array<{ fileId: number; path: string; name: string }>;

    // Filter to supported extensions in TS rather than SQL — keeps the schema
    // free of an extension column and is fast on the row count we'll see
    // (hundreds of thousands max).
    return rows.filter((r) => classifyByExtension(r.name) !== "unsupported");
  }

  private async runChunk(chunk: FileTarget[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.worker = new Worker(
        new URL("./media-metadata-worker.ts", import.meta.url).href
      );

      this.worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        switch (msg.type) {
          case "file_done":
            this.persist(msg.fileId, msg.metadata);
            this.progress.filesCompleted += 1;
            if (msg.metadata.datetimeOriginal) this.progress.withDatetime += 1;
            if (msg.metadata.extractionError) this.progress.errors += 1;
            this.incrementProgress({
              itemsProcessed: 1,
              progressJson: this.progress,
            });
            break;
          case "done":
            this.worker?.terminate();
            this.worker = null;
            resolve();
            break;
          case "error":
            this.worker?.terminate();
            this.worker = null;
            reject(new Error(msg.message));
            break;
        }
      };

      this.worker.onerror = (event) => {
        this.worker?.terminate();
        this.worker = null;
        reject(new Error(`Worker error: ${event.message}`));
      };

      this.worker.postMessage({ type: "start", files: chunk });
    });
  }

  private persist(fileId: number, m: ExtractedMetadata): void {
    this.db
      .prepare(
        `INSERT INTO media_metadata
           (file_id, datetime_original, datetime_source, captured_at_unix,
            make, model, extraction_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           datetime_original = excluded.datetime_original,
           datetime_source   = excluded.datetime_source,
           captured_at_unix  = excluded.captured_at_unix,
           make              = excluded.make,
           model             = excluded.model,
           extraction_error  = excluded.extraction_error,
           extracted_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      )
      .run(
        fileId,
        m.datetimeOriginal,
        m.datetimeSource,
        m.capturedAtUnix,
        m.make,
        m.model,
        m.extractionError
      );
  }

  private broadcast(): void {
    this.incrementProgress({ progressJson: this.progress });
  }
}
