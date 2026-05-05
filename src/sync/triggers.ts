/**
 * Firestore Cloud Function triggers that publish {@link SyncEvent}s to
 * Google Cloud PubSub.
 *
 * Dependencies (`firebase-functions`, `@google-cloud/pubsub`) are injected
 * via the `deps` config property — no lazy loading or module resolution issues.
 *
 * Out-of-order delivery is handled at the application level: every event
 * carries a `version` (publish-time `Date.now()` in ms) which is propagated
 * to SQL as the `__sync_version` column. The worker's MERGE only updates a
 * row when the incoming `version` is strictly greater than the stored one —
 * so a stale event delivered after a newer one is silently skipped.
 *
 * @example
 * ```typescript
 * import { createSyncTriggers } from "@lpdjs/firestore-repo-service/sync";
 * import * as firestoreTriggers from "firebase-functions/v2/firestore";
 * import { PubSub } from "@google-cloud/pubsub";
 *
 * const triggers = createSyncTriggers(repos, {
 *   deps: { firestoreTriggers, pubsub: new PubSub() },
 *   topicPrefix: "my-sync",
 *   repos: { users: { exclude: ["password"] } },
 * });
 *
 * export const { users_onCreate, users_onUpdate, users_onDelete } = triggers;
 * ```
 */

import { serializeDocument } from "./serializer";
import type { RepoSyncConfig, SyncEvent, SyncTriggersConfig } from "./types";

const DEFAULT_TOPIC_PREFIX = "firestore-sync";

/**
 * Derive the Firestore document path pattern for a trigger.
 * Returns `null` when the collection path cannot be determined.
 */
function buildDocumentPath(repoName: string, repo: any): string | null {
  const collectionPath: string | undefined =
    (repo as any).ref?.path ?? undefined;

  if (!collectionPath) {
    console.warn(
      `[SyncTriggers] Cannot determine collection path for "${repoName}". Skipping.`,
    );
    return null;
  }

  return `${collectionPath}/{docId}`;
}

/**
 * Create Firestore Cloud Functions (v2) triggers that publish
 * {@link SyncEvent}s to PubSub for each repository in `repoMapping`.
 *
 * For each non-group repository, three triggers are created:
 * - `{repoName}_onCreate` → publishes an `INSERT` event
 * - `{repoName}_onUpdate` → publishes an `UPSERT` event
 * - `{repoName}_onDelete` → publishes a `DELETE` event
 *
 * Each event carries a monotonic `version` (`Date.now()` in ms) used by
 * the worker to discard out-of-order PubSub deliveries.
 */
export function createSyncTriggers<M extends Record<string, any>>(
  repoMapping: M,
  config: SyncTriggersConfig<NoInfer<M>>,
): Record<string, any> {
  const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
    config.deps.firestoreTriggers;
  const pubsub = config.deps.pubsub;

  const topicPrefix = config?.topicPrefix ?? DEFAULT_TOPIC_PREFIX;
  const triggers: Record<string, any> = {};

  // Cache topic clients so the publisher reuses the same batching state
  // for a given topic across invocations.
  const topicCache = new Map<string, any>();
  function getTopic(topicName: string): any {
    let t = topicCache.get(topicName);
    if (t) return t;
    t = (pubsub as any).topic(topicName);
    topicCache.set(topicName, t);
    return t;
  }

  async function publish(
    topicName: string,
    syncEvent: SyncEvent,
  ): Promise<void> {
    const topic = getTopic(topicName);
    await topic.publishMessage({ json: syncEvent });
  }

  for (const [repoName, repo] of Object.entries(repoMapping) as [
    string,
    any,
  ][]) {
    const repoCfg = (
      config?.repos as Record<string, RepoSyncConfig<string>> | undefined
    )?.[repoName];

    let documentPath: string | null;

    if ((repo as any)._isGroup) {
      if (!repoCfg?.triggerPath) {
        console.warn(
          `[SyncTriggers] Skipping collection-group repo "${repoName}". ` +
            "Provide a triggerPath in the sync repos config for group collections.",
        );
        continue;
      }
      documentPath = repoCfg.triggerPath;
    } else {
      documentPath = repoCfg?.triggerPath ?? buildDocumentPath(repoName, repo);
    }
    if (!documentPath) continue;

    const documentKey: string = (repo as any)._systemKeys?.[0] ?? "docId";
    const topicName = `${topicPrefix}-${repoName}`;

    triggers[`${repoName}_onCreate`] = onDocumentCreated(
      documentPath,
      async (event: any) => {
        const snap = event.data;
        if (!snap) return;

        const data = snap.data() as Record<string, unknown> | undefined;
        if (!data) return;

        const docId = String(data[documentKey] ?? snap.id);
        const serialized = serializeDocument(data, {
          exclude: repoCfg?.exclude,
          columnMap: repoCfg?.columnMap,
        });

        const syncEvent: SyncEvent = {
          operation: "INSERT",
          repoName,
          docId,
          data: serialized,
          timestamp: new Date().toISOString(),
          version: Date.now(),
        };

        await publish(topicName, syncEvent);
      },
    );

    triggers[`${repoName}_onUpdate`] = onDocumentUpdated(
      documentPath,
      async (event: any) => {
        const snap = event.data?.after;
        if (!snap) return;

        const data = snap.data() as Record<string, unknown> | undefined;
        if (!data) return;

        const docId = String(data[documentKey] ?? snap.id);
        const serialized = serializeDocument(data, {
          exclude: repoCfg?.exclude,
          columnMap: repoCfg?.columnMap,
        });

        const syncEvent: SyncEvent = {
          operation: "UPSERT",
          repoName,
          docId,
          data: serialized,
          timestamp: new Date().toISOString(),
          version: Date.now(),
        };

        await publish(topicName, syncEvent);
      },
    );

    triggers[`${repoName}_onDelete`] = onDocumentDeleted(
      documentPath,
      async (event: any) => {
        const snap = event.data;
        if (!snap) return;

        const data = snap.data() as Record<string, unknown> | undefined;
        const docId = String(data?.[documentKey] ?? snap.id);

        const syncEvent: SyncEvent = {
          operation: "DELETE",
          repoName,
          docId,
          data: null,
          timestamp: new Date().toISOString(),
          version: Date.now(),
        };

        await publish(topicName, syncEvent);
      },
    );
  }

  return triggers;
}
