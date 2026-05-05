/**
 * PubSub worker — creates a Cloud Function that receives {@link SyncEvent}
 * messages from PubSub, routes them to per-repo {@link SyncQueue}s, and
 * flushes batches to the configured {@link SqlAdapter}.
 *
 * Dependencies (`firebase-functions`, `@google-cloud/pubsub`) are injected
 * via the `deps` config property.
 */

import { z } from "zod";
import { SYNC_VERSION_COLUMN } from "./constants";
import { SyncQueue } from "./queue";
import { zodSchemaToColumns } from "./schema-mapper";
import type {
  RepoSyncConfig,
  SqlAdapter,
  SyncEvent,
  SyncWorkerConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Migration tracking
// ---------------------------------------------------------------------------

/** Set of repo names that have already been migrated in this process lifetime. */
const migratedRepos = new Set<string>();

async function ensureMigrated(
  repoName: string,
  adapter: SqlAdapter,
  schema: z.ZodObject<any>,
  tableName: string,
  primaryKey: string,
  exclude?: string[],
  columnMap?: Record<string, string>,
): Promise<void> {
  if (migratedRepos.has(repoName)) return;

  const columns = zodSchemaToColumns(schema, adapter.dialect, {
    primaryKey,
    exclude,
    columnMap,
  });

  const exists = await adapter.tableExists(tableName);
  if (!exists) {
    await adapter.createTable({ tableName, columns });
  } else {
    const existing = new Set(await adapter.getTableColumns(tableName));
    const newCols = columns.filter((c) => !existing.has(c.name));
    if (newCols.length > 0) {
      await adapter.addColumns(tableName, newCols);
    }
  }

  migratedRepos.add(repoName);
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create a PubSub-triggered Cloud Function that syncs Firestore changes
 * to a SQL database.
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
    adapter,
    batchSize = 100,
    flushIntervalMs = 5_000,
    autoMigrate = false,
    topicPrefix = "firestore-sync",
    workerOptions,
    repos: repoConfigs = {} as Record<
      string,
      RepoSyncConfig<string> | undefined
    >,
  } = config;

  // Build per-repo queues lazily
  const queues = new Map<string, SyncQueue>();

  function getQueue(repoName: string, primaryKey: string): SyncQueue {
    let q = queues.get(repoName);
    if (q) return q;

    const repoCfg = repoConfigs[repoName];
    const tableName = repoCfg?.tableName ?? repoName;

    // On flush failure → log error + re-publish to PubSub dead-letter
    const onFlushError = async (
      events: SyncEvent[],
      error: unknown,
    ): Promise<void> => {
      console.error(
        `[SyncWorker] Flush failed for "${repoName}" (${events.length} events):`,
        error,
      );
      try {
        const dlTopicName = `${topicPrefix}-${repoName}-dlq`;
        const dlTopic = deps.pubsub.topic(dlTopicName);
        const [exists] = await dlTopic.exists();
        if (!exists) {
          await dlTopic.create();
          console.info(`[SyncWorker] Created DLQ topic "${dlTopicName}"`);
        }
        for (const evt of events) {
          await dlTopic.publishMessage({ json: evt });
        }
      } catch (dlErr) {
        console.error(
          `[SyncWorker] Dead-letter publish also failed for ${repoName}:`,
          dlErr,
        );
      }
    };

    q = new SyncQueue({
      adapter,
      tableName,
      primaryKey,
      batchSize,
      flushIntervalMs,
      onFlushError,
    });
    queues.set(repoName, q);
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
    // The primaryKey for BigQuery must use the mapped column name (e.g. docId → user_id)
    const primaryKey = columnMap?.[documentKey] ?? documentKey;

    if (autoMigrate) {
      const schema: z.ZodObject<any> | undefined =
        (repo as any).schema ?? undefined;
      if (schema) {
        const tableName = repoCfg?.tableName ?? repoName;
        await ensureMigrated(
          repoName,
          adapter,
          schema,
          tableName,
          documentKey,
          repoCfg?.exclude,
          columnMap,
        );
      }
    }

    const queue = getQueue(repoName, primaryKey);

    // Stamp the row with the publish version so the SQL adapter can skip
    // stale (out-of-order) updates. Force-sync events without a version
    // fall back to the wall clock — still monotonic per-process.
    if (syncEvent.data) {
      syncEvent.data[SYNC_VERSION_COLUMN] = syncEvent.version ?? Date.now();
    }

    queue.enqueue(syncEvent);
  }

  // Cloud Function v2 PubSub handler (sync — deps are already available)
  function createHandler(topicName: string) {
    const handlerFn = async (event: any) => {
      const data: SyncEvent = event.data?.message?.json ?? event.data?.json;
      if (!data) {
        console.warn("[SyncWorker] Received empty PubSub message");
        return;
      }
      await handleMessage(data);
      // Flush so data is persisted before the Cloud Function container shuts down.
      // Force-sync (admin) handles its own flush after the batch loop.
      const q = queues.get(data.repoName);
      if (q) await q.flush();
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
      for (const q of queues.values()) {
        promises.push(q.shutdown());
      }
      await Promise.all(promises);
    },
  };
}
