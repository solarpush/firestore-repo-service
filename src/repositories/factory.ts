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
 * Creates a configured repository instance with all methods
 */
export function createRepository<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any, any, any>
>(
  db: Firestore,
  config: T,
  allRepositories: Record<string, any> = {}
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
    config.documentKey as string
  );
  const queryMethods = createQueryMethods(
    collectionRef as Query,
    config.queryKeys
  );
  const aggregateMethods = createAggregateMethods(collectionRef as Query);
  const crudMethods = createCrudMethods(
    actualCollection,
    documentRef,
    config.documentKey as string,
    config.pathKey as string | undefined,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined
  );
  const batchMethods = createBatchMethods(
    db,
    documentRef,
    config.documentKey as string,
    config.pathKey as string | undefined,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined
  );
  const transactionMethods = createTransactionMethods(db, documentRef);
  const bulkMethods = createBulkMethods(
    db,
    config.createdKey as string | undefined,
    config.updatedKey as string | undefined
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
  } as unknown as ConfiguredRepository<T>;
}
