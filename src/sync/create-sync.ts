/**
 * Unified wrapper — combines triggers + worker into a single call.
 *
 * @example
 * ```typescript
 * const sync = createFirestoreSync(repos, {
 *   adapter,
 *   topicPrefix: "firestore-sync",
 *   autoMigrate: true,
 *   repos: {
 *     users: { exclude: ["documentPath"], columnMap: { docId: "user_id" } },
 *     posts: { columnMap: { docId: "post_id" } },
 *   },
 * });
 *
 * module.exports = { ...module.exports, ...sync.functions };
 * ```
 */

import { createSyncTriggers } from "./triggers";
import { createSyncWorker } from "./worker";
import type { FirestoreSyncConfig, SyncEvent } from "./types";
import type { SyncQueue } from "./queue";

const DEFAULT_TOPIC_PREFIX = "firestore-sync";

export function createFirestoreSync<M extends Record<string, any>>(
  repoMapping: M,
  config: FirestoreSyncConfig<NoInfer<M>>,
) {
  const {
    adapter,
    topicPrefix = DEFAULT_TOPIC_PREFIX,
    batchSize,
    flushIntervalMs,
    autoMigrate,
    repos: repoConfigs,
  } = config;

  // Create triggers (Firestore → PubSub)
  const triggers = createSyncTriggers(repoMapping, {
    topicPrefix,
    repos: repoConfigs,
  });

  // Create worker (PubSub → SQL)
  const worker = createSyncWorker(repoMapping, {
    adapter,
    batchSize,
    flushIntervalMs,
    autoMigrate,
    repos: repoConfigs,
  });

  // Auto-create a PubSub handler per repo
  const handlers: Record<string, any> = {};
  for (const repoName of Object.keys(repoMapping)) {
    handlers[`sync_${repoName}`] = worker.createHandler(
      `${topicPrefix}-${repoName}`,
    );
  }

  return {
    /** All Cloud Functions (triggers + handlers) — spread into module.exports */
    functions: { ...triggers, ...handlers } as Record<string, any>,
    /** Only the Firestore triggers */
    triggers,
    /** Only the PubSub worker handlers */
    handlers,
    /** Process a SyncEvent directly (for testing) */
    handleMessage: worker.handleMessage as (event: SyncEvent) => Promise<void>,
    /** Internal queue map (for testing) */
    queues: worker.queues as Map<string, SyncQueue>,
    /** Flush all queues and stop timers */
    shutdown: worker.shutdown as () => Promise<void>,
  };
}
