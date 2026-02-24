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
 * Creates query.by* methods for query keys.
 * These methods return arrays of documents matching a query condition.
 *
 * @template T - The document type
 * @param collectionRef - Firestore query reference
 * @param queryKeys - Array of field names to generate query methods for
 * @param relationalKeys - Optional relation configuration for includes
 * @param allRepositories - Optional map of all repositories for relation resolution
 * @returns Object containing generated query methods
 *
 * @example
 * ```typescript
 * // Generated methods based on queryKeys: ["status", "categoryId"]
 * // Basic usage - get all posts with status "published"
 * const publishedPosts = await repos.posts.query.byStatus("published");
 *
 * // With options - filter, sort, limit and select
 * const recentPosts = await repos.posts.query.byStatus("published", {
 *   orderBy: [["createdAt", "desc"]],
 *   limit: 10,
 *   select: ["title", "createdAt"]
 * });
 *
 * // Generic query.by with full options
 * const filteredPosts = await repos.posts.query.by({
 *   where: [["views", ">=", 1000]],
 *   orWhere: [
 *     ["status", "==", "published"],
 *     ["status", "==", "featured"]
 *   ],
 *   orderBy: [["views", "desc"]],
 *   limit: 20
 * });
 *
 * // Pagination with include (relation population)
 * const paginatedPosts = await repos.posts.query.paginate({
 *   pageSize: 10,
 *   orderBy: [["createdAt", "desc"]],
 *   include: ["userId", { relation: "categoryId", select: ["name"] }]
 * });
 *
 * // Iterate through all pages
 * for await (const page of repos.posts.query.paginateAll({ pageSize: 50 })) {
 *   console.log(`Processing ${page.data.length} posts`);
 * }
 * ```
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

  queryMethods.paginateAll = async function* (
    options: Omit<
      PaginationWithIncludeOptions<T, string>,
      "cursor" | "direction"
    >,
  ): AsyncGenerator<
    | PaginationResult<T>
    | PaginationResult<T & { populated: Record<string, any> }>,
    void,
    unknown
  > {
    const { include, ...paginationOptions } = options;
    for await (const page of createPaginationIterator<T>(
      collectionRef,
      paginationOptions,
    )) {
      if (include && include.length > 0) {
        const populatedData = await populateDocuments(page.data, include);
        yield { ...page, data: populatedData };
      } else {
        yield page;
      }
    }
  };

  return queryMethods;
}
