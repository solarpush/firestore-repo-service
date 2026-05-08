/**
 * `createHistoryTriggers` — generates Firestore Cloud Functions (v2) that
 * capture every write to a configured repository and write a v2 history
 * entry into the entity's history subcollection.
 *
 * Mirrors the DI / per-repo override pattern of {@link createSyncTriggers}.
 *
 * @example
 * ```ts
 * import { createHistoryTriggers } from "@lpdjs/firestore-repo-service/history";
 * import * as firestoreTriggers from "firebase-functions/v2/firestore";
 *
 * const triggers = createHistoryTriggers(repos, {
 *   deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
 *   defaults: { ttl: { days: 365 } },
 * });
 *
 * export const { residences_onHistory, prevention_workshops_onHistory } = triggers;
 * ```
 */

import { computeDiff } from "./diff";
import {
  buildHistoryEntry,
  extractMeta,
  metaFieldsOf,
  writeHistoryEntry,
} from "./write";
import type {
  HistoryConfigForModel,
  HistoryOperation,
  HistoryTriggersConfig,
} from "./types";

const DEFAULT_SUBCOLLECTION = "history";

/** Determine the trigger document path pattern for a non-group repo. */
function buildDocumentPath(repoName: string, repo: any): string | null {
  const collectionPath: string | undefined =
    (repo as any).ref?.path ?? undefined;
  if (!collectionPath) {
    console.warn(
      `[HistoryTriggers] Cannot determine collection path for "${repoName}". Skipping.`,
    );
    return null;
  }
  return `${collectionPath}/{docId}`;
}

export function createHistoryTriggers<M extends Record<string, any>>(
  repoMapping: M,
  config: HistoryTriggersConfig<NoInfer<M>>,
): Record<string, any> {
  const { onDocumentWritten } = config.deps;
  const triggers: Record<string, any> = {};

  for (const [repoName, repo] of Object.entries(repoMapping) as [
    string,
    any,
  ][]) {
    const repoCfg = (repo as any).history as
      | (HistoryConfigForModel<unknown> & { enabled: boolean })
      | undefined;
    if (!repoCfg?.enabled) continue;

    const subcollection = repoCfg.subcollection ?? DEFAULT_SUBCOLLECTION;
    const ttl = repoCfg.ttl ?? config.defaults?.ttl;

    const override = config.repos?.[repoName as keyof M & string];
    let documentPath: string | null;
    if ((repo as any)._isGroup) {
      if (!override?.triggerPath) {
        console.warn(
          `[HistoryTriggers] Skipping collection-group repo "${repoName}". ` +
            "Provide a triggerPath in the history triggers repos override.",
        );
        continue;
      }
      documentPath = override.triggerPath;
    } else {
      documentPath = override?.triggerPath ?? buildDocumentPath(repoName, repo);
    }
    if (!documentPath) continue;

    const systemKeys: string[] = (repo as any)._systemKeys ?? [];
    const documentKey: string = systemKeys[0] ?? "docId";
    const metaFields = metaFieldsOf(repoCfg as HistoryConfigForModel<unknown>);

    triggers[`${repoName}_onHistory`] = onDocumentWritten(
      documentPath,
      async (event: any) => {
        try {
          const before = event.data?.before?.data() as
            | Record<string, unknown>
            | undefined;
          const after = event.data?.after?.data() as
            | Record<string, unknown>
            | undefined;

          let operation: HistoryOperation;
          if (!before && after) operation = "create";
          else if (before && !after) operation = "delete";
          else if (before && after) operation = "update";
          else return;

          const docId = String(
            after?.[documentKey] ??
              before?.[documentKey] ??
              event.params?.docId ??
              event.data?.after?.id ??
              event.data?.before?.id ??
              "",
          );
          if (!docId) return;

          const changes = computeDiff(before ?? {}, after ?? {}, {
            include: repoCfg.include as string[] | undefined,
            exclude: repoCfg.exclude as string[] | undefined,
            metaFields,
            systemKeys,
          });

          if (operation === "update" && Object.keys(changes).length === 0) {
            return; // no relevant change
          }

          const meta = extractMeta(
            after ?? before ?? null,
            repoCfg as HistoryConfigForModel<unknown>,
          );

          const entry = buildHistoryEntry({
            entityId: docId,
            operation,
            changes,
            meta,
            config: repoCfg as HistoryConfigForModel<unknown>,
            ttlOverride: ttl,
          });

          // Build the subcollection ref from the parent doc ref of the trigger.
          const parentRef =
            event.data?.after?.ref ?? event.data?.before?.ref;
          if (!parentRef) return;
          const historyRef = parentRef.collection(subcollection);

          await writeHistoryEntry(
            historyRef,
            entry,
            repoCfg as HistoryConfigForModel<unknown>,
            {
              repoName,
              docId,
              before: (before ?? null) as any,
              after: (after ?? null) as any,
            },
          );
        } catch (err) {
          console.error(
            `[HistoryTriggers] Failed to record history for "${repoName}":`,
            err,
          );
        }
      },
    );
  }

  return triggers;
}
