/**
 * In-process pub/sub registry for Server-Sent Events, keyed by job ID.
 *
 * Lifecycle:
 *   1. HTTP handler calls `subscribe(jobId)` → gets an AsyncIterable<SseEvent>
 *      and streams it to the client via Hono's streamSSE.
 *   2. JobRunner calls `publish(jobId, event)` on every progress flush or
 *      status change.
 *   3. When the client disconnects (or the job ends), the iterator is garbage-
 *      collected and the subscription is removed.
 */

export interface SseEvent {
  event: string;
  data: unknown;
}

type Listener = (event: SseEvent) => void;

class SseRegistry {
  private listeners = new Map<number, Set<Listener>>();

  /**
   * Subscribes to events for `jobId`. Returns an unsubscribe function.
   */
  subscribe(jobId: number, listener: Listener): () => void {
    if (!this.listeners.has(jobId)) {
      this.listeners.set(jobId, new Set());
    }
    this.listeners.get(jobId)!.add(listener);
    return () => {
      const set = this.listeners.get(jobId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  /**
   * Publishes an event to all subscribers of `jobId`.
   */
  publish(jobId: number, event: string, data: unknown): void {
    this.listeners.get(jobId)?.forEach((l) => l({ event, data }));
  }

  /** Number of active subscribers for a job (useful in tests). */
  subscriberCount(jobId: number): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }
}

// Module-level singleton — no external dependencies, safe to construct eagerly.
export const sseRegistry = new SseRegistry();
