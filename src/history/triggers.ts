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

/** Static, db-free metadata needed to register a history trigger. */
interface RepoHistoryMeta {
  historyConfig: (HistoryConfigForModel<unknown> & { enabled: boolean }) | undefined;
  systemKeys: string[];
  isGroup: boolean;
  /** Collection path of a non-group repo (used to derive the trigger path). */
  collectionPath: string | null;
}

/** Read history metadata from a **raw repository config** (no db resolution). */
function metaFromConfig(cfg: any): RepoHistoryMeta {
  const historyConfig =
    cfg && typeof cfg.history === "object" && cfg.history !== null
      ? cfg.history
      : undefined;
  const systemKeys = [
    cfg?.documentKey,
    cfg?.pathKey,
    cfg?.createdKey,
    cfg?.updatedKey,
  ].filter((k): k is string => typeof k === "string");
  return {
    historyConfig,
    systemKeys,
    isGroup: !!cfg?.isGroup,
    collectionPath: typeof cfg?.path === "string" ? cfg.path : null,
  };
}

/** Read history metadata from a **resolved repository** (forces db resolution). */
function metaFromRepo(repo: any): RepoHistoryMeta {
  const historyConfig =
    repo._historyConfig ??
    // Backward-compat: older repos exposed the config under `.history`
    // (before that key became the methods namespace).
    (typeof repo.history === "object" &&
    repo.history !== null &&
    "enabled" in repo.history
      ? repo.history
      : undefined);
  return {
    historyConfig,
    systemKeys: (repo._systemKeys as string[]) ?? [],
    isGroup: !!repo._isGroup,
    collectionPath: repo.ref?.path ?? null,
  };
}

/** Determine the trigger document path pattern for a non-group repo. */
function buildDocumentPath(repoName: string, collectionPath: string | null): string | null {
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

  // Prefer the raw mapping config (exposed by `createRepositoryMapping`) so we
  // register triggers WITHOUT resolving Firestore — mirroring the lazy db
  // initialization used by the repository methods. Falls back to introspecting
  // the resolved repositories when a plain repo object is passed.
  const rawMapping: Record<string, any> | undefined = (repoMapping as any)
    ?.rawMapping;
  const entries: [string, RepoHistoryMeta][] = rawMapping
    ? Object.entries(rawMapping).map(([name, cfg]) => [name, metaFromConfig(cfg)])
    : (Object.entries(repoMapping) as [string, any][]).map(([name, repo]) => [
        name,
        metaFromRepo(repo),
      ]);

  for (const [repoName, meta] of entries) {
    const repoCfg = meta.historyConfig;
    if (!repoCfg?.enabled) continue;

    const subcollection = repoCfg.subcollection ?? DEFAULT_SUBCOLLECTION;
    const ttl = repoCfg.ttl ?? config.defaults?.ttl;

    const override = config.repos?.[repoName as keyof M & string];
    let documentPath: string | null;
    if (meta.isGroup) {
      if (!override?.triggerPath) {
        console.warn(
          `[HistoryTriggers] Skipping collection-group repo "${repoName}". ` +
            "Provide a triggerPath in the history triggers repos override.",
        );
        continue;
      }
      documentPath = override.triggerPath;
    } else {
      documentPath =
        override?.triggerPath ??
        buildDocumentPath(repoName, meta.collectionPath);
    }
    if (!documentPath) continue;

    const systemKeys: string[] = meta.systemKeys;
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
