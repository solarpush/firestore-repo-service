/**
 * PubSub worker — creates a Cloud Function that receives {@link SyncEvent}
 * messages from PubSub, routes them to per-repo / per-adapter {@link SyncQueue}s, and
 * flushes batches to the configured {@link SyncAdapter}s.
 *
 * Dependencies (`firebase-functions`, `@google-cloud/pubsub`) are injected
 * via the `deps` config property.
 */

import { z } from "zod";
import { SchemaTypeMismatchError } from "./adapters/bigquery";
import { SYNC_VERSION_COLUMN } from "./constants";
import { SyncQueue } from "./queue";
import { zodSchemaToColumns } from "./schema-mapper";
import type {
  RepoSyncConfig,
  SyncAdapter,
  SyncEvent,
  SyncWorkerConfig,
} from "./types";

export { SchemaTypeMismatchError };

// ---------------------------------------------------------------------------
// Migration tracking
// ---------------------------------------------------------------------------

/** Set of `${repoName}:${adapter.name}` pairs that have already been migrated. */
const migratedTargets = new Set<string>();

async function ensureMigratedTarget(
  repoName: string,
  adapter: SyncAdapter,
  schema: z.ZodObject<any>,
  tableName: string,
  primaryKey: string,
  exclude?: string[],
  columnMap?: Record<string, string>,
): Promise<void> {
  const migrationKey = `${repoName}:${adapter.name}`;
  if (migratedTargets.has(migrationKey)) return;

  if (typeof adapter.ensureTarget === "function") {
    await adapter.ensureTarget({
      targetName: tableName,
      primaryKey,
      schema,
      exclude,
      columnMap,
    });
  } else if ("dialect" in adapter && typeof (adapter as any).createTable === "function") {
    const sqlAdapter = adapter as any;
    const columns = zodSchemaToColumns(schema, sqlAdapter.dialect, {
      primaryKey,
      exclude,
      columnMap,
    });
    const exists = await sqlAdapter.tableExists(tableName);
    if (!exists) {
      await sqlAdapter.createTable({ tableName, columns });
    } else {
      const existing = new Set(await sqlAdapter.getTableColumns(tableName));
      const newCols = columns.filter((c: any) => !existing.has(c.name));
      if (newCols.length > 0) {
        await sqlAdapter.addColumns(tableName, newCols);
        await sqlAdapter.onSchemaChange?.(tableName);
      }
    }
  }

  migratedTargets.add(migrationKey);
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create a PubSub-triggered Cloud Function that syncs Firestore changes
 * to target storage adapters.
 *
 * Returns an object with:
 * - `createHandler` — creates a Cloud Function for a PubSub topic
 * - `handleMessage` — process a SyncEvent directly (for testing)
 * - `queues` — internal SyncQueue map (for testing / manual flush)
 * - `shutdown()` — flush all queues and stop timers
 */
export function createSyncWorker<M extends Record<string, any>>(
  repoMapping: M,
  config: SyncWorkerConfig<NoInfer<M>>,
) {
  const {
    deps,
    adapter: rawAdapter,
    adapters: rawAdaptersList,
    batchSize = 100,
    flushIntervalMs = 5_000,
    autoMigrate = false,
    topicPrefix = "firestore-sync",
    maxDlqAttempts = 5,
    workerOptions,
    repos: repoConfigs = {} as Record<
      string,
      RepoSyncConfig<string> | undefined
    >,
  } = config;

  // Normalize adapters list
  const normalizedRawAdapters: any[] = rawAdaptersList
    ? rawAdaptersList
    : Array.isArray(rawAdapter)
      ? rawAdapter
      : rawAdapter
        ? [rawAdapter]
        : [];

  const adapters: SyncAdapter[] = normalizedRawAdapters.map((a) =>
    typeof a === "function" ? a() : a,
  );

  function getAdaptersForRepo(repoName: string): SyncAdapter[] {
    const repoCfg = repoConfigs[repoName];
    if (repoCfg?.adapters && repoCfg.adapters.length > 0) {
      const allowed = new Set(repoCfg.adapters);
      return adapters.filter((a) => allowed.has(a.name));
    }
    return adapters;
  }

  // Build per-repo/per-adapter queues lazily
  const queues = new Map<string, SyncQueue>();

  function getQueue(
    repoName: string,
    adapter: SyncAdapter,
    primaryKey: string,
  ): SyncQueue {
    const queueKey = `${repoName}:${adapter.name}`;
    let q = queues.get(queueKey);
    if (q) return q;

    const repoCfg = repoConfigs[repoName];
    const tableName = repoCfg?.tableName ?? repoName;

    // Per-adapter DLQ topic for isolated failure recovery
    const dlTopicName = `${topicPrefix}-${repoName}-${adapter.name}-dlq`;
    const dlTopic = deps.pubsub.topic(dlTopicName);
    let dlTopicEnsured = false;

    const ensureDlTopic = async (): Promise<void> => {
      if (dlTopicEnsured) return;
      try {
        await dlTopic.create();
        console.info(
          `[SyncWorker:${adapter.name}] Created DLQ topic "${dlTopicName}"`,
        );
      } catch (e: unknown) {
        if ((e as { code?: number })?.code !== 6) throw e; // 6 = ALREADY_EXISTS
      }
      dlTopicEnsured = true;
    };

    const onFlushError = async (
      events: SyncEvent[],
      error: unknown,
    ): Promise<void> => {
      console.error(
        `[SyncWorker:${adapter.name}] Flush failed for "${repoName}" (${events.length} events):`,
        error,
      );
      await ensureDlTopic();

      await Promise.all(
        events.map((evt) => {
          const attempts = (evt.attempts ?? 0) + 1;
          if (maxDlqAttempts > 0 && attempts > maxDlqAttempts) {
            console.error(
              `[SyncWorker:${adapter.name}] Dropping event for "${repoName}" after ${attempts - 1} DLQ attempts:`,
              { docId: evt.docId, operation: evt.operation },
            );
            return Promise.resolve();
          }
          const payload: SyncEvent = {
            ...evt,
            attempts,
            firstFailedAt: evt.firstFailedAt ?? Date.now(),
          };
          return dlTopic.publishMessage({ json: payload });
        }),
      );
    };

    q = new SyncQueue({
      adapter,
      tableName,
      primaryKey,
      batchSize,
      flushIntervalMs,
      onFlushError,
    });
    queues.set(queueKey, q);
    // Also alias by repoName for single-adapter convenience
    if (!queues.has(repoName)) {
      queues.set(repoName, q);
    }
    return q;
  }

  // Message handler (works with or without Cloud Functions wrapper)
  async function handleMessage(syncEvent: SyncEvent): Promise<void> {
    const { repoName } = syncEvent;
    const repo = (repoMapping as Record<string, any>)[repoName];
    if (!repo) {
      console.warn(`[SyncWorker] Unknown repo "${repoName}", skipping event`);
      return;
    }

    const documentKey: string =
      (repo as any)._systemKeys?.[0] ?? (repo as any).documentKey ?? "docId";

    const repoCfg = repoConfigs[repoName];
    const columnMap = repoCfg?.columnMap as Record<string, string> | undefined;
    const primaryKey = columnMap?.[documentKey] ?? documentKey;

    if (syncEvent.data) {
      syncEvent.data[SYNC_VERSION_COLUMN] = syncEvent.version ?? Date.now();
    }

    const targetAdapters = getAdaptersForRepo(repoName);
    for (const adapter of targetAdapters) {
      if (autoMigrate) {
        const schema: z.ZodObject<any> | undefined =
          (repo as any).schema ?? undefined;
        if (schema) {
          const tableName = repoCfg?.tableName ?? repoName;
          await ensureMigratedTarget(
            repoName,
            adapter,
            schema,
            tableName,
            primaryKey,
            repoCfg?.exclude,
            columnMap,
          );
        }
      }

      const queue = getQueue(repoName, adapter, primaryKey);
      queue.enqueue(syncEvent);
    }
  }

  // Cloud Function v2 PubSub handler
  function createHandler(topicName: string) {
    const handlerFn = async (event: any) => {
      const data: SyncEvent = event.data?.message?.json ?? event.data?.json;
      if (!data) {
        console.warn("[SyncWorker] Received empty PubSub message");
        return;
      }
      await handleMessage(data);

      // Flush all queues associated with this repo
      const targetAdapters = getAdaptersForRepo(data.repoName);
      for (const adapter of targetAdapters) {
        const queueKey = `${data.repoName}:${adapter.name}`;
        const q = queues.get(queueKey);
        if (q) await q.flush();
      }
    };

    if (workerOptions) {
      return deps.pubsubHandler.onMessagePublished(
        { topic: topicName, ...workerOptions },
        handlerFn,
      );
    }
    return deps.pubsubHandler.onMessagePublished(topicName, handlerFn);
  }

  return {
    /** Process a SyncEvent directly (for testing or custom PubSub integration). */
    handleMessage,
    /** Create a Cloud Function handler for a specific PubSub topic. */
    createHandler,
    /** Internal queue map (for testing). */
    queues,
    /** Flush all queues and stop timers. */
    async shutdown(): Promise<void> {
      const promises: Promise<void>[] = [];
      const visited = new Set<SyncQueue>();
      for (const q of queues.values()) {
        if (!visited.has(q)) {
          visited.add(q);
          promises.push(q.shutdown());
        }
      }
      await Promise.all(promises);
    },
  };
}
