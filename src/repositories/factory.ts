import type {
  CollectionReference,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import { createHistoryMethods, type HistoryMethods } from "../history/read";
import { createAggregateMethods } from "../methods/aggregate";
import { createBatchMethods } from "../methods/batch";
import { createBulkMethods } from "../methods/bulk";
import { createCrudMethods } from "../methods/crud";
import { createGetMethods } from "../methods/get";
import { createQueryMethods } from "../methods/query";
import { createPopulateMethods } from "../methods/relations";
import { createSystemMethods } from "../methods/system";
import { createTransactionMethods } from "../methods/transaction";
import type { RepositoryConfig } from "../shared/types";
import type { ConfiguredRepository } from "./types";

/**
 * Extract parent-key parameter names from a refCb function.
 * For `(db, postId, docId) => …` this returns `["postId"]` (everything
 * between the first param – the Firestore `db` – and the last param – the
 * document's own ID).
 * Returns an empty array when the function has ≤ 2 params (db + docId).
 * @internal
 */
function extractParentKeys(refCb: unknown): string[] {
  if (typeof refCb !== "function") return [];
  const src = refCb.toString();
  const match = src.match(/^\s*(?:function\s*\w*\s*)?\(([^)]*)\)/);
  if (!match?.[1]) return [];
  const params = match[1]
    .split(",")
    .map((p) => p.trim().replace(/\s*[:=].*$/, "").trim())
    .filter(Boolean);
  // (db, docId) → 0 parents; (db, parentId, docId) → 1 parent; etc.
  if (params.length <= 2) return [];
  return params.slice(1, -1);
}

/**
 * Build the **static** repository metadata that server/trigger builders read at
 * definition time (schema, system keys, path/group flags, history settings,
 * relational keys) directly from a raw repository **config** — i.e. without
 * resolving Firestore. Mirrors the same fields exposed by the resolved
 * repository, so it can back a {@link makeLazyRepo} overlay.
 */
export function buildRepoStaticMeta(config: any): Record<string, unknown> {
  const systemKeys = [
    config?.documentKey,
    config?.pathKey,
    config?.createdKey,
    config?.updatedKey,
  ].filter((k): k is string => typeof k === "string");
  const historyConfig =
    config?.history && typeof config.history === "object"
      ? config.history
      : undefined;
  return {
    schema: config?.schema,
    _systemKeys: systemKeys,
    _pathKey: (config?.pathKey as string | undefined) ?? null,
    _isGroup: !!config?.isGroup,
    _createdKey: (config?.createdKey as string | undefined) ?? null,
    _parentKeys: config?.isGroup ? extractParentKeys(config?.refCb) : [],
    relationalKeys: config?.relationalKeys,
    _historyConfig: historyConfig,
    _historySubcollection: historyConfig?.enabled
      ? (historyConfig.subcollection ?? "history")
      : undefined,
    // Collection path of a non-group repo (== resolved `ref.path`). Lets
    // trigger builders derive the document path without resolving the db.
    _collectionPath: typeof config?.path === "string" ? config.path : null,
  };
}

/**
 * Wrap a repository behind a lazy Proxy: **static** metadata (see
 * {@link buildRepoStaticMeta}) is served from `config` without resolving
 * Firestore, while every dynamic access (`ref`, `get`, `query`, `history.*`, …)
 * resolves the real repository on first use via `resolve()` and memoizes it.
 *
 * Lets server builders read static config at module-load time without forcing
 * `getFirestore()` — the db is only touched when a request handler actually
 * uses a repository method.
 */
export function makeLazyRepo<R>(config: any, resolve: () => R): R {
  const overlay = buildRepoStaticMeta(config);
  let resolved: R | undefined;
  const ensure = (): R => (resolved ??= resolve());
  return new Proxy(overlay as any, {
    get(_t, prop) {
      if (typeof prop === "string" && prop in overlay) {
        return (overlay as any)[prop];
      }
      return (ensure() as any)[prop];
    },
    has(_t, prop) {
      if (typeof prop === "string" && prop in overlay) return true;
      return prop in (ensure() as any);
    },
  }) as R;
}

/**
 * Creates a configured repository instance with all methods
 */
export function createRepository<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any, any, any, any>,
>(
  db: Firestore,
  config: T,
  allRepositories: Record<string, any> = {},
): ConfiguredRepository<T> {
  // Create collection reference
  const collectionRef: CollectionReference | Query = config.isGroup
    ? db.collectionGroup(config.path)
    : db.collection(config.path);

  // Keep actual collection for create operations
  const actualCollection = config.isGroup ? null : db.collection(config.path);

  // Create document reference function
  const documentRef = (...args: any[]) => (config.refCb as any)(db, ...args);

  // Create all method groups
  const getMethods = createGetMethods(
    collectionRef as Query,
    config.foreignKeys,
    actualCollection,
    documentRef,
    config.documentKey as string,
  );
  const queryMethods = createQueryMethods(
    collectionRef as Query,
    config.queryKeys,
    config.relationalKeys as Record<string, any> | undefined,
    allRepositories,
  );
  const aggregateMethods = createAggregateMethods(collectionRef as Query);
  const crudMethods = createCrudMethods(
    actualCollection,
    documentRef,
    config.documentKey as string,
    config.pathKey as string | undefined,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined,
  );
  const batchMethods = createBatchMethods(
    db,
    documentRef,
    config.documentKey as string,
    config.pathKey as string | undefined,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined,
  );
  const transactionMethods = createTransactionMethods(db, documentRef);
  const bulkMethods = createBulkMethods(
    db,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined,
  );
  const systemMethods = createSystemMethods(
    db,
    collectionRef,
    config.documentKey as string,
    config.pathKey as string | undefined,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined,
  );
  const populateMethods = createPopulateMethods(config, allRepositories);

  // History namespace (opt-in via config.history.enabled)
  const historyConfig = (config as any).history as
    | { enabled: boolean; [k: string]: any }
    | undefined;
  const history: HistoryMethods<any> | null =
    historyConfig?.enabled
      ? (createHistoryMethods(
          documentRef,
          [
            config.documentKey as string,
            config.pathKey as string | undefined,
            config.createdKey as string | undefined,
            config.updatedKey as string | undefined,
          ].filter((k): k is string => typeof k === "string"),
          (config as any).path ?? "(unknown)",
          historyConfig as any,
        ) as HistoryMethods<any>)
      : null;

  return {
    ref: collectionRef,
    documentRef,
    get: getMethods,
    query: queryMethods,
    aggregate: aggregateMethods,
    ...crudMethods,
    batch: batchMethods,
    transaction: transactionMethods,
    bulk: bulkMethods,
    system: systemMethods,
    ...populateMethods,
    ...(history ? { history } : {}),
    // Expose the configured history subcollection name (when history is enabled)
    // so external consumers (admin UI, etc.) can display / link it correctly.
    _historySubcollection: history
      ? (historyConfig?.subcollection ?? "history")
      : undefined,
    // Expose the raw history config so trigger builders (createHistoryTriggers)
    // can introspect `enabled`, `meta`, `include`, `exclude`, `ttl`, `subcollection`.
    // The public `history` key is intentionally the methods namespace, not the
    // config — this private field bridges the two without breaking that API.
    _historyConfig: historyConfig,
    // Pass through the Zod schema if one was attached via createRepositoryConfig(schema)
    schema: (config as any).schema,
    // Pass through relational keys built by buildRepositoryRelations
    relationalKeys: (config as any).relationalKeys,
    // Auto-managed keys that should never be accepted in user-provided payloads
    _systemKeys: [
      config.documentKey as string,
      config.pathKey as string | undefined,
      config.createdKey as string | undefined,
      config.updatedKey as string | undefined,
    ].filter((k): k is string => typeof k === "string"),
    // Expose pathKey name so server handlers can extract path args from documents
    _pathKey: (config.pathKey as string | undefined) ?? null,
    // Whether this is a collectionGroup repository
    _isGroup: !!config.isGroup,
    // Parent key field names auto-detected from refCb signature
    _parentKeys: config.isGroup
      ? extractParentKeys(config.refCb)
      : [],
    // Expose createdKey so server handlers can inject it when using set() for creates
    _createdKey: (config.createdKey as string | undefined) ?? null,
  } as unknown as ConfiguredRepository<T>;
}
