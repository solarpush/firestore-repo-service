/**
 * Per-repo in-memory batch buffer.
 *
 * Accumulates {@link SyncEvent}s and flushes them in batches to a
 * {@link SqlAdapter}. On flush failure the events are re-published
 * to PubSub for retry (if a PubSub re-publisher is provided).
 */

import type { SqlAdapter, SyncEvent } from "./types";

export interface SyncQueueOptions {
  /** SQL adapter to flush data to */
  adapter: SqlAdapter;
  /** SQL table name */
  tableName: string;
  /** Primary key column name */
  primaryKey: string;
  /** Max rows per flush (default: 100) */
  batchSize?: number;
  /** Auto-flush interval in ms (default: 5_000). 0 = manual only. */
  flushIntervalMs?: number;
  /** Called on flush failure with the failed events. Typically re-publishes to PubSub. */
  onFlushError?: (events: SyncEvent[], error: unknown) => Promise<void>;
}

/**
 * In-memory buffer that batches sync events per-repo and flushes them
 * to a SQL adapter.
 */
export class SyncQueue {
  private buffer: SyncEvent[] = [];
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly adapter: SqlAdapter;
  private readonly tableName: string;
  private readonly primaryKey: string;
  private readonly batchSize: number;
  private readonly onFlushError?: SyncQueueOptions["onFlushError"];

  constructor(opts: SyncQueueOptions) {
    this.adapter = opts.adapter;
    this.tableName = opts.tableName;
    this.primaryKey = opts.primaryKey;
    this.batchSize = opts.batchSize ?? 100;
    this.onFlushError = opts.onFlushError;

    const interval = opts.flushIntervalMs ?? 5_000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      // Allow the Node process to exit even if the timer is running
      if (typeof this.timer === "object" && "unref" in this.timer) {
        this.timer.unref();
      }
    }
  }

  /** Number of events waiting in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** Push one or more events into the buffer. Triggers auto-flush if batchSize reached. */
  enqueue(...events: SyncEvent[]): void {
    this.buffer.push(...events);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Flush all buffered events to the SQL adapter.
   * Upserts and deletes are batched separately.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    // Drain the buffer atomically
    const batch = this.buffer.splice(0, this.batchSize);

    try {
      const upserts: Record<string, unknown>[] = [];
      const deleteIds: string[] = [];

      for (const evt of batch) {
        if (evt.operation === "DELETE") {
          deleteIds.push(evt.docId);
        } else if (evt.data) {
          upserts.push(evt.data);
        }
      }

      if (upserts.length > 0) {
        await this.adapter.upsertRows(this.tableName, upserts, this.primaryKey);
      }
      if (deleteIds.length > 0) {
        await this.adapter.deleteRows(
          this.tableName,
          this.primaryKey,
          deleteIds,
        );
      }
    } catch (err) {
      if (this.onFlushError) {
        await this.onFlushError(batch, err).catch(() => {
          /* swallow re-publish errors to avoid infinite loops */
        });
      } else {
        // Re-insert at the front so we retry next flush
        this.buffer.unshift(...batch);
        console.error(`[SyncQueue] Flush failed for ${this.tableName}:`, err);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stop the auto-flush timer and flush remaining events. */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
