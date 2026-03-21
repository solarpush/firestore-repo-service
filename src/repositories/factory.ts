import type {
  CollectionReference,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import { createAggregateMethods } from "../methods/aggregate";
import { createBatchMethods } from "../methods/batch";
import { createBulkMethods } from "../methods/bulk";
import { createCrudMethods } from "../methods/crud";
import { createGetMethods } from "../methods/get";
import { createQueryMethods } from "../methods/query";
import { createPopulateMethods } from "../methods/relations";
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
 * Creates a configured repository instance with all methods
 */
export function createRepository<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any, any, any>,
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
  const populateMethods = createPopulateMethods(config, allRepositories);

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
    ...populateMethods,
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
