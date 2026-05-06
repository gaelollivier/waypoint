import { LockManager } from "./lock-manager";

let _lockManager: LockManager | null = null;

export function initLockManager(db: import("bun:sqlite").Database): LockManager {
  _lockManager = new LockManager(db);
  return _lockManager;
}

export function getLockManager(): LockManager {
  if (!_lockManager) throw new Error("LockManager not initialized — call initLockManager first");
  return _lockManager;
}
