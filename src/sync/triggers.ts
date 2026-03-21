/**
 * Firestore Cloud Function triggers that publish {@link SyncEvent}s to
 * Google Cloud PubSub.
 *
 * The triggers are created lazily — `firebase-functions` and
 * `@google-cloud/pubsub` are only required at call time so the rest of
 * the library works without those optional dependencies.
 *
 * @example
 * ```typescript
 * import { createSyncTriggers } from "@lpdjs/firestore-repo-service/sync";
 *
 * const triggers = createSyncTriggers(repos, {
 *   topicPrefix: "my-sync",
 *   repos: { users: { exclude: ["password"] } },
 * });
 *
 * // Re-export the triggers so Firebase discovers them:
 * export const { users_onCreate, users_onUpdate, users_onDelete } = triggers;
 * ```
 */

import { serializeDocument } from "./serializer";
import type { RepoSyncConfig, SyncEvent, SyncTriggersConfig } from "./types";

// ---------------------------------------------------------------------------
// Lazy dependency loaders
// ---------------------------------------------------------------------------

type FirestoreTriggers = typeof import("firebase-functions/v2/firestore");

let _firestoreTriggers: FirestoreTriggers | undefined;

function getFirestoreTriggers(): FirestoreTriggers {
  if (!_firestoreTriggers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _firestoreTriggers = require("firebase-functions/v2/firestore");
    } catch {
      throw new Error(
        "firebase-functions is required for sync triggers. " +
          "Install it: npm install firebase-functions",
      );
    }
  }
  return _firestoreTriggers!;
}

let _pubsub: any;

function getPubSub(): any {
  if (!_pubsub) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PubSub } = require("@google-cloud/pubsub");
      _pubsub = new PubSub();
    } catch {
      throw new Error(
        "@google-cloud/pubsub is required for sync triggers. " +
          "Install it: npm install @google-cloud/pubsub",
      );
    }
  }
  return _pubsub;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create Firestore Cloud Functions (v2) triggers that publish
 * {@link SyncEvent}s to PubSub for each repository in `repoMapping`.
 *
 * For each non-group repository, three triggers are created:
 * - `{repoName}_onCreate` → publishes an `INSERT` event
 * - `{repoName}_onUpdate` → publishes an `UPSERT` event
 * - `{repoName}_onDelete` → publishes a `DELETE` event
 *
 * Collection-group repositories (`_isGroup === true`) are skipped because
 * they require an explicit document path pattern that cannot be derived
 * generically.
 *
 * @param repoMapping - Object whose keys are repo names and values are
 *   `ConfiguredRepository` instances (or any object with a `ref` property
 *   pointing to a Firestore `CollectionReference`).
 * @param config - Optional overrides for topic naming and per-repo
 *   serialization.
 * @returns An object of Cloud Functions keyed by
 *   `{repoName}_onCreate / onUpdate / onDelete`.
 */
export function createSyncTriggers<M extends Record<string, any>>(
  repoMapping: M,
  config?: SyncTriggersConfig<NoInfer<M>>,
): Record<string, any> {
  const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
    getFirestoreTriggers();
  const pubsub = getPubSub();

  const topicPrefix = config?.topicPrefix ?? DEFAULT_TOPIC_PREFIX;
  const triggers: Record<string, any> = {};

  for (const [repoName, repo] of Object.entries(repoMapping) as [string, any][]) {
    if ((repo as any)._isGroup) {
      console.warn(
        `[SyncTriggers] Skipping collection-group repo "${repoName}". ` +
          "Provide explicit trigger paths for group collections.",
      );
      continue;
    }

    const documentPath = buildDocumentPath(repoName, repo);
    if (!documentPath) continue;

    const documentKey: string =
      (repo as any)._systemKeys?.[0] ?? "docId";
    const repoCfg = (config?.repos as Record<string, RepoSyncConfig<string>> | undefined)?.[repoName];
    const topicName = `${topicPrefix}-${repoName}`;

    // -- onCreate ---------------------------------------------------------
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
        };

        await pubsub.topic(topicName).publishMessage({ json: syncEvent });
      },
    );

    // -- onUpdate ---------------------------------------------------------
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
        };

        await pubsub.topic(topicName).publishMessage({ json: syncEvent });
      },
    );

    // -- onDelete ---------------------------------------------------------
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
        };

        await pubsub.topic(topicName).publishMessage({ json: syncEvent });
      },
    );
  }

  return triggers;
}
