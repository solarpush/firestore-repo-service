import type { Query } from "firebase-admin/firestore";
import {
  createPaginationIterator,
  executePaginatedQuery,
  type PaginationOptions,
  type PaginationResult,
} from "../pagination";
import { buildAndExecuteQuery } from "../query-builder";
import type {
  QueryOptions,
  RelationConfig,
  WhereClause,
} from "../shared/types";
import { applyQueryOptions, capitalize } from "../shared/utils";

/**
 * Include configuration for a relation with optional select
 */
export interface IncludeConfig {
  /** The relation key to include */
  relation: string;
  /** Fields to select from the related documents (Firestore select) */
  select?: string[];
}

/**
 * Options for pagination with include support
 */
export interface PaginationWithIncludeOptions<
  T,
  TRelationKeys = string,
> extends PaginationOptions<T> {
  /** Relations to include in results - can be relation keys or IncludeConfig objects */
  include?: (TRelationKeys | IncludeConfig)[];
}

/**
 * Creates query.by* methods for query keys
 */
export function createQueryMethods<T>(
  collectionRef: Query,
  queryKeys: readonly string[],
  relationalKeys?: Record<string, RelationConfig>,
  allRepositories?: Record<string, any>,
) {
  const queryMethods: any = {};

  /**
   * Resolve included relations for a list of documents (parallel per document,
   * parallel per relation). Stores results by field key to avoid repo-name collisions.
   */
  const populateDocuments = async (
    documents: T[],
    includeConfigs: (string | IncludeConfig)[],
  ): Promise<(T & { populated: Record<string, any> })[]> => {
    if (!relationalKeys || !allRepositories || includeConfigs.length === 0) {
      return documents as any;
    }

    const normalizedConfigs: { key: string; select?: string[] }[] =
      includeConfigs.map((cfg) =>
        typeof cfg === "string"
          ? { key: cfg }
          : { key: cfg.relation, select: cfg.select },
      );

    return Promise.all(
      documents.map(async (doc) => {
        const entries = await Promise.all(
          normalizedConfigs.map(async ({ key, select }) => {
            const relation = relationalKeys[key];
            if (!relation) return [key, undefined] as const;

            const targetRepo = allRepositories[relation.repo];
            if (!targetRepo) return [key, undefined] as const;

            const fieldValue = (doc as any)[key];
            if (fieldValue === undefined || fieldValue === null) {
              return [key, relation.type === "one" ? null : []] as const;
            }

            const opts = select ? { select } : undefined;

            try {
              if (relation.type === "one") {
                const method = `by${capitalize(relation.key)}`;
                const result =
                  typeof targetRepo.get?.[method] === "function"
                    ? await targetRepo.get[method](fieldValue, opts)
                    : null;
                return [key, result] as const;
              } else {
                const method = `by${capitalize(relation.key)}`;
                const result =
                  typeof targetRepo.query?.[method] === "function"
                    ? await targetRepo.query[method](fieldValue, opts)
                    : [];
                return [key, result] as const;
              }
            } catch (err) {
              console.error(`[include] Error populating "${key}":`, err);
              return [key, relation.type === "one" ? null : []] as const;
            }
          }),
        );

        const populated: Record<string, any> = {};
        for (const [k, v] of entries) {
          if (k !== undefined) populated[k] = v;
        }
        return { ...doc, populated };
      }),
    );
  };

  // Generate query.by* methods — inject queryKey condition into options so
  // orWhere and other advanced options are all handled by buildAndExecuteQuery.
  queryKeys.forEach((queryKey: string) => {
    const methodName = `by${capitalize(queryKey)}`;
    queryMethods[methodName] = async (
      value: any,
      options: QueryOptions<T> = {},
    ): Promise<T[]> => {
      const mergedOptions: QueryOptions<T> = {
        ...options,
        where: [
          [queryKey, "==", value] as unknown as WhereClause<T>,
          ...(options.where ?? []),
        ],
      };
      const snapshot = await buildAndExecuteQuery<T>(
        collectionRef,
        mergedOptions,
      );
      return snapshot.docs.map((doc) => doc.data() as T);
    };
  });

  // Generic query.by — full orWhere support via buildAndExecuteQuery
  queryMethods.by = async (options: QueryOptions<T>): Promise<T[]> => {
    const snapshot = await buildAndExecuteQuery<T>(collectionRef, options);
    return snapshot.docs.map((doc) => doc.data() as T);
  };

  // getAll — full orWhere support via buildAndExecuteQuery
  queryMethods.getAll = async (options: QueryOptions<T> = {}): Promise<T[]> => {
    const snapshot = await buildAndExecuteQuery<T>(collectionRef, options);
    return snapshot.docs.map((doc) => doc.data() as T);
  };

  // onSnapshot — real-time listener (orWhere not supported by Firestore SDK real-time)
  queryMethods.onSnapshot = (
    options: QueryOptions<T>,
    onNext: (data: T[]) => void,
    onError?: (error: Error) => void,
  ): (() => void) => {
    const q = applyQueryOptions(collectionRef, options);
    return q.onSnapshot((snapshot) => {
      onNext(snapshot.docs.map((doc) => doc.data() as T));
    }, onError);
  };

  // Paginate — includes relation resolution after each page
  queryMethods.paginate = async (
    options: PaginationWithIncludeOptions<T, string>,
  ): Promise<
    | PaginationResult<T>
    | PaginationResult<T & { populated: Record<string, any> }>
  > => {
    const { include, ...paginationOptions } = options;
    const result = await executePaginatedQuery<T>(
      collectionRef,
      paginationOptions,
    );

    if (include && include.length > 0) {
      const populatedData = await populateDocuments(result.data, include);
      return { ...result, data: populatedData };
    }

    return result;
  };

  queryMethods.paginateAll = (
    options: Omit<
      PaginationWithIncludeOptions<T, string>,
      "cursor" | "direction"
    >,
  ) => createPaginationIterator(collectionRef, options);

  return queryMethods;
}
