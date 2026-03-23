/**
 * Unified wrapper — combines triggers + worker into a single call.
 *
 * @example
 * ```typescript
 * import * as firestoreTriggers from "firebase-functions/v2/firestore";
 * import * as pubsubHandler from "firebase-functions/v2/pubsub";
 * import { PubSub } from "@google-cloud/pubsub";
 *
 * const sync = createFirestoreSync(repos, {
 *   deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
 *   adapter,
 *   topicPrefix: "firestore-sync",
 *   autoMigrate: true,
 *   admin: {
 *     auth: { type: "basic", username: "admin", password: "secret" },
 *     featuresFlag: { healthCheck: true, manualSync: true, viewQueue: true },
 *   },
 *   repos: {
 *     users: { exclude: ["documentPath"], columnMap: { docId: "user_id" } },
 *     posts: { columnMap: { docId: "post_id" } },
 *   },
 * });
 *
 * // Triggers + PubSub handlers
 * export const { users_onCreate, users_onUpdate, users_onDelete, sync_users } = sync.functions;
 *
 * // Admin endpoint — wrap with onRequest yourself
 * export const adminsync = onRequest(sync.adminHandler!);
 *
 * // Or pass onRequest in admin config to auto-add to sync.functions:
 * // admin: { onRequest, ... } → export const { adminsync } = sync.functions;
 * ```
 */

import { createadminsyncServer } from "./admin";
import type { SyncQueue } from "./queue";
import { createSyncTriggers } from "./triggers";
import type { FirestoreSyncConfig, OrFactory, RepoSyncConfig, SyncEvent } from "./types";
import { createSyncWorker } from "./worker";

const DEFAULT_TOPIC_PREFIX = "firestore-sync";

/**
 * Wraps a value-or-factory into a lazy proxy that only instantiates
 * when a property is first accessed. If the value is already an instance,
 * returns it as-is (zero overhead).
 */
function lazyProxy<T extends object>(v: OrFactory<T>): T {
  if (typeof v !== "function") return v;
  const factory = v as () => T;
  let instance: T | undefined;
  return new Proxy({} as T, {
    get(_, prop) {
      if (!instance) instance = factory();
      return (instance as any)[prop];
    },
    has(_, prop) {
      if (!instance) instance = factory();
      return prop in (instance as object);
    },
  });
}

export function createFirestoreSync<M extends Record<string, any>>(
  repoMapping: M,
  config: FirestoreSyncConfig<NoInfer<M>>,
) {
  const {
    deps,
    adapter: rawAdapter,
    topicPrefix = DEFAULT_TOPIC_PREFIX,
    batchSize,
    flushIntervalMs,
    autoMigrate,
    admin: adminConfig,
    repos: repoConfigs,
  } = config;

  // Resolve lazy deps — instances are returned as-is, factories are wrapped
  // in a proxy that defers construction until the first property access.
  const pubsub = lazyProxy(deps.pubsub);
  const adapter = lazyProxy(rawAdapter);

  // Create triggers (Firestore → PubSub)
  const triggers = createSyncTriggers(repoMapping, {
    deps: { firestoreTriggers: deps.firestoreTriggers, pubsub },
    topicPrefix,
    repos: repoConfigs,
  });

  // Create worker (PubSub → SQL)
  const worker = createSyncWorker(repoMapping, {
    deps: { pubsubHandler: deps.pubsubHandler, pubsub },
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

  // Optional admin endpoint
  let adminHandler: ((req: any, res: any) => Promise<void>) | null = null;
  if (adminConfig) {
    adminHandler = createadminsyncServer(
      repoMapping,
      adapter,
      worker.queues as Map<string, SyncQueue>,
      worker.handleMessage as (event: SyncEvent) => Promise<void>,
      adminConfig,
      (repoConfigs ?? {}) as Record<string, RepoSyncConfig<string> | undefined>,
      pubsub,
      topicPrefix,
    );
    // If onRequest is provided, wrap it as a Cloud Function automatically.
    // Otherwise expose the raw handler so the user can wrap it.
    handlers["adminsync"] = adminConfig.onRequest
      ? adminConfig.httpsOptions
        ? adminConfig.onRequest(adminConfig.httpsOptions, adminHandler)
        : adminConfig.onRequest(adminHandler)
      : adminHandler;
  }

  const result = {
    /** All Cloud Functions (triggers + handlers + optional admin) — spread into exports */
    functions: { ...triggers, ...handlers } as Record<string, any>,
    /**
     * Raw admin HTTP handler — wrap with `onRequest()` yourself if you
     * didn't pass `onRequest` in the admin config.
     * @example
     * ```ts
     * export const adminsync = onRequest(sync.adminHandler!);
     * ```
     */
    adminHandler: adminHandler as
      | ((req: any, res: any) => Promise<void>)
      | null,
    /** Process a SyncEvent directly (for testing) */
    handleMessage: worker.handleMessage as (event: SyncEvent) => Promise<void>,
    /** Internal queue map (for testing) */
    queues: worker.queues as Map<string, SyncQueue>,
    /** Flush all queues and stop timers */
    shutdown: worker.shutdown as () => Promise<void>,
  };

  // Hide non-function properties from Firebase's recursive discovery.
  // Only `functions` is enumerable — the rest is accessible but invisible to Object.keys().
  for (const key of [
    "adminHandler",
    "handleMessage",
    "queues",
    "shutdown",
  ] as const) {
    Object.defineProperty(result, key, { enumerable: false });
  }

  return result;
}
