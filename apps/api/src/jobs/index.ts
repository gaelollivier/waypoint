import { JobManager } from "./job-manager";
import type { JobRunner } from "./job-runner";

let _jobManager: JobManager | null = null;

/** Active (non-terminal) runners, keyed by job ID. */
const activeRunners = new Map<number, JobRunner>();

export function initJobManager(db: import("bun:sqlite").Database): JobManager {
  _jobManager = new JobManager(db);
  return _jobManager;
}

export function getJobManager(): JobManager {
  if (!_jobManager) throw new Error("JobManager not initialized");
  return _jobManager;
}

export function registerRunner(jobId: number, runner: JobRunner): void {
  activeRunners.set(jobId, runner);
}

export function unregisterRunner(jobId: number): void {
  activeRunners.delete(jobId);
}

export function getRunner(jobId: number): JobRunner | undefined {
  return activeRunners.get(jobId);
}
