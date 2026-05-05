/**
 * Pub/Sub infrastructure setup for the Firestore → SQL sync.
 *
 * Cloud Functions v2 (`onMessagePublished`) auto-creates topics and push
 * subscriptions on deploy — **but without `enableMessageOrdering`**. This
 * helper pre-creates the topics and subscriptions with ordering enabled, so
 * that the Cloud Function reuses the existing subscription on deploy.
 *
 * Run it as a one-off script (e.g. in CI before `firebase deploy`) or call
 * it manually from a setup script. Idempotent: existing resources are kept
 * as-is (subscriptions are NOT recreated, since `enableMessageOrdering` is
 * immutable after creation — a warning is logged if mismatched).
 *
 * @example
 * ```typescript
 * import { PubSub } from "@google-cloud/pubsub";
 * import { ensureSyncInfra } from "@lpdjs/firestore-repo-service/sync";
 *
 * await ensureSyncInfra(repos, {
 *   pubsub: new PubSub(),
 *   topicPrefix: "firestore-sync",
 *   ordering: true,
 *   subscriptionSuffix: "sync-sub", // default
 *   includeDLQ: true,
 * });
 * ```
 */

import type { PubSubClientDep } from "./types";

export interface EnsureSyncInfraOptions {
  /** PubSub client (`new PubSub()` from `@google-cloud/pubsub`). */
  pubsub: PubSubClientDep;
  /** Topic prefix — must match the value used by `createSyncTriggers`. */
  topicPrefix?: string;
  /**
   * Whether to enable message ordering on the created subscriptions.
   * Default: `true`.
   */
  ordering?: boolean;
  /**
   * Suffix appended to each topic name to derive the subscription name.
   * Final name: `{topicPrefix}-{repoName}-{subscriptionSuffix}`.
   * Default: `"sync-sub"`.
   */
  subscriptionSuffix?: string;
  /**
   * Also create the dead-letter topic (`{prefix}-{repoName}-dlq`) used by
   * `createSyncWorker` on flush failures. Default: `true`.
   */
  includeDLQ?: boolean;
  /**
   * Ack deadline in seconds for the created subscriptions. Default: `60`.
   */
  ackDeadlineSeconds?: number;
  /**
   * Optional message retention duration (e.g. `"604800s"` for 7 days).
   */
  messageRetentionDuration?: string;
}

export interface EnsureSyncInfraResult {
  topics: { name: string; created: boolean }[];
  subscriptions: {
    name: string;
    topic: string;
    created: boolean;
    orderingEnabled: boolean;
    /** Set when an existing subscription has the wrong ordering setting. */
    warning?: string;
  }[];
}

/**
 * Idempotently create the Pub/Sub topics + subscriptions used by the sync
 * pipeline, with `enableMessageOrdering` set on subscriptions.
 */
export async function ensureSyncInfra<M extends Record<string, any>>(
  repoMapping: M,
  opts: EnsureSyncInfraOptions,
): Promise<EnsureSyncInfraResult> {
  const {
    pubsub,
    topicPrefix = "firestore-sync",
    ordering = true,
    subscriptionSuffix = "sync-sub",
    includeDLQ = true,
    ackDeadlineSeconds = 60,
    messageRetentionDuration,
  } = opts;

  const result: EnsureSyncInfraResult = { topics: [], subscriptions: [] };

  for (const repoName of Object.keys(repoMapping)) {
    const topicName = `${topicPrefix}-${repoName}`;
    const subName = `${topicPrefix}-${repoName}-${subscriptionSuffix}`;

    // ---- Topic --------------------------------------------------------
    const topic = (pubsub as any).topic(topicName);
    let topicCreated = false;
    const [topicExists] = await topic.exists();
    if (!topicExists) {
      await topic.create();
      topicCreated = true;
      console.info(`[ensureSyncInfra] Created topic "${topicName}"`);
    }
    result.topics.push({ name: topicName, created: topicCreated });

    // ---- Subscription -------------------------------------------------
    const sub = topic.subscription(subName);
    const [subExists] = await sub.exists();
    if (!subExists) {
      await sub.create({
        enableMessageOrdering: ordering,
        ackDeadlineSeconds,
        ...(messageRetentionDuration ? { messageRetentionDuration } : {}),
      });
      console.info(
        `[ensureSyncInfra] Created subscription "${subName}" (ordering=${ordering})`,
      );
      result.subscriptions.push({
        name: subName,
        topic: topicName,
        created: true,
        orderingEnabled: ordering,
      });
    } else {
      // Subscription already exists — enableMessageOrdering is immutable.
      let warning: string | undefined;
      let actualOrdering = ordering;
      try {
        const [meta] = await sub.getMetadata();
        actualOrdering = Boolean(meta?.enableMessageOrdering);
        if (actualOrdering !== ordering) {
          warning =
            `Subscription "${subName}" exists with enableMessageOrdering=${actualOrdering}, ` +
            `but ordering=${ordering} was requested. This setting is immutable; ` +
            `delete and recreate the subscription to change it.`;
          console.warn(`[ensureSyncInfra] ${warning}`);
        }
      } catch {
        // ignore metadata fetch failures (minimal client)
      }
      result.subscriptions.push({
        name: subName,
        topic: topicName,
        created: false,
        orderingEnabled: actualOrdering,
        ...(warning ? { warning } : {}),
      });
    }

    // ---- DLQ topic ----------------------------------------------------
    if (includeDLQ) {
      const dlqName = `${topicPrefix}-${repoName}-dlq`;
      const dlq = (pubsub as any).topic(dlqName);
      const [dlqExists] = await dlq.exists();
      let dlqCreated = false;
      if (!dlqExists) {
        await dlq.create();
        dlqCreated = true;
        console.info(`[ensureSyncInfra] Created DLQ topic "${dlqName}"`);
      }
      result.topics.push({ name: dlqName, created: dlqCreated });
    }
  }

  return result;
}
