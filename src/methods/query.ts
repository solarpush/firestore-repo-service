import type { Query, QuerySnapshot } from "firebase-admin/firestore";
import {
  createPaginationIterator,
  executePaginatedQuery,
  type PaginationOptions,
  type PaginationResult,
} from "../pagination";
import type { QueryOptions, RelationConfig } from "../shared/types";
import { capitalize } from "../shared/utils";

/**
 * Options for pagination with include support
 */
export interface PaginationWithIncludeOptions<T, TRelationKeys = string>
  extends PaginationOptions<T> {
  /** Relations to include in results */
  include?: TRelationKeys[];
}

/**
 * Apply query options to a Firestore query
 */
export function applyQueryOptions(q: Query, options: QueryOptions): Query {
  if (options.where) {
    options.where.forEach(([field, operator, value]) => {
      q = q.where(String(field), operator, value);
    });
  }

  if (options.orderBy) {
    options.orderBy.forEach((o) => {
      q = q.orderBy(String(o.field), o.direction || "asc");
    });
  }

  if (options.limit) {
    q = q.limit(options.limit);
  }

  if (options.offset) {
    q = q.offset(options.offset);
  }

  // Cursor-based pagination
  if (options.startAt) {
    q = Array.isArray(options.startAt)
      ? q.startAt(...options.startAt)
      : q.startAt(options.startAt);
  }

  if (options.startAfter) {
    q = Array.isArray(options.startAfter)
      ? q.startAfter(...options.startAfter)
      : q.startAfter(options.startAfter);
  }

  if (options.endAt) {
    q = Array.isArray(options.endAt)
      ? q.endAt(...options.endAt)
      : q.endAt(options.endAt);
  }

  if (options.endBefore) {
    q = Array.isArray(options.endBefore)
      ? q.endBefore(...options.endBefore)
      : q.endBefore(options.endBefore);
  }

  return q;
}

/**
 * Creates query.by* methods for query keys
 */
export function createQueryMethods<T>(
  collectionRef: Query,
  queryKeys: readonly string[],
  relationalKeys?: Record<string, RelationConfig>,
  allRepositories?: Record<string, any>
) {
  const queryMethods: any = {};

  /**
   * Helper to populate documents with relations
   */
  const populateDocuments = async (
    documents: T[],
    includeKeys: string[]
  ): Promise<(T & { populated: Record<string, any> })[]> => {
    if (!relationalKeys || !allRepositories || includeKeys.length === 0) {
      return documents as any;
    }

    const results: (T & { populated: Record<string, any> })[] = [];

    for (const doc of documents) {
      const populated: Record<string, any> = {};

      for (const key of includeKeys) {
        const relation = relationalKeys[key];
        if (!relation) continue;

        const targetRepo = allRepositories[relation.repo];
        if (!targetRepo) continue;

        const fieldValue = (doc as any)[key];
        if (fieldValue === undefined || fieldValue === null) {
          populated[relation.repo] = relation.type === "one" ? null : [];
          continue;
        }

        try {
          if (relation.type === "one") {
            const getMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.get?.[getMethod] === "function") {
              populated[relation.repo] = await targetRepo.get[getMethod](
                fieldValue
              );
            } else {
              populated[relation.repo] = null;
            }
          } else {
            const queryMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.query?.[queryMethod] === "function") {
              populated[relation.repo] = await targetRepo.query[queryMethod](
                fieldValue
              );
            } else {
              populated[relation.repo] = [];
            }
          }
        } catch (error) {
          console.error(`[include] Error populating "${key}":`, error);
          populated[relation.repo] = relation.type === "one" ? null : [];
        }
      }

      results.push({ ...doc, populated });
    }

    return results;
  };

  // Generate query.by* methods for each query key
  queryKeys.forEach((queryKey: string) => {
    const methodName = `by${capitalize(String(queryKey))}`;
    queryMethods[methodName] = async (
      value: string,
      options: QueryOptions = {}
    ): Promise<T[]> => {
      let q: Query = collectionRef as any;
      q = q.where(String(queryKey), "==", value);
      q = applyQueryOptions(q, options);
      const snapshot: QuerySnapshot = await q.get();
      return snapshot.docs.map((doc) => doc.data() as T);
    };
  });

  // Generic query.by method
  queryMethods.by = async (options: QueryOptions): Promise<T[]> => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);
    const snapshot: QuerySnapshot = await q.get();
    return snapshot.docs.map((doc) => doc.data() as T);
  };

  // getAll - retrieve all documents
  queryMethods.getAll = async (options: QueryOptions = {}): Promise<T[]> => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);
    const snapshot: QuerySnapshot = await q.get();
    return snapshot.docs.map((doc) => doc.data() as T);
  };

  // onSnapshot - real-time listener
  queryMethods.onSnapshot = (
    options: QueryOptions,
    onNext: (data: T[]) => void,
    onError?: (error: Error) => void
  ): (() => void) => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);

    return q.onSnapshot((snapshot) => {
      const data = snapshot.docs.map((doc) => doc.data() as T);
      onNext(data);
    }, onError);
  };

  // Pagination methods with include support
  queryMethods.paginate = async (
    options: PaginationWithIncludeOptions<T, string>
  ): Promise<
    | PaginationResult<T>
    | PaginationResult<T & { populated: Record<string, any> }>
  > => {
    const { include, ...paginationOptions } = options;
    const result = await executePaginatedQuery<T>(
      collectionRef as Query,
      paginationOptions
    );

    // If include is specified, populate the relations
    if (include && include.length > 0) {
      const populatedData = await populateDocuments(result.data, include);
      return {
        ...result,
        data: populatedData,
      };
    }

    return result;
  };

  queryMethods.paginateAll = (
    options: Omit<
      PaginationWithIncludeOptions<T, string>,
      "cursor" | "direction"
    >
  ) => {
    // Note: include will be applied per page in the iterator
    return createPaginationIterator(collectionRef as Query, options);
  };

  return queryMethods;
}
