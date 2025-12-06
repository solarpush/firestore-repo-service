/* eslint-disable @typescript-eslint/no-empty-object-type */

import type { Firestore } from "firebase-admin/firestore";

// ============================================
// Re-exports from modules
// ============================================

// Shared types
export type {
  ExtractDocumentRefSignature,
  ExtractUpdateSignature,
  FieldPath,
  GetResult,
  QueryOptions,
  RelationalKeys,
  RelationConfig,
  RepositoryConfig,
  WhereClause,
} from "./src/shared/types";

// Pagination
export {
  applyQueryOptions as applyPaginationQueryOptions,
  createPaginationIterator,
  executePaginatedQuery,
} from "./src/pagination";
export type { PaginationOptions, PaginationResult } from "./src/pagination";

// Query with include
export type { PaginationWithIncludeOptions } from "./src/methods/query";

// Query builder
export { buildAndExecuteQuery } from "./src/query-builder";

// Repository types
export type {
  ConfiguredRepository,
  GenerateGetMethods,
  GenerateQueryMethods,
} from "./src/repositories/types";

// ============================================
// Imports for internal use
// ============================================

import { createRepository } from "./src/repositories/factory";
import type { ConfiguredRepository } from "./src/repositories/types";
import type { RelationConfig, RepositoryConfig } from "./src/shared/types";

// ============================================
// Repository Configuration Helper
// ============================================

/**
 * Helper to create a typed repository configuration with literal type preservation
 * Uses currying pattern to allow type parameter inference
 * @template T - The data model type
 * @returns Builder function that accepts repository configuration with withRelations method
 * @example
 * ```typescript
 * const mapping = {
 *   users: createRepositoryConfig<UserModel>()({
 *     path: "users",
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["isActive"] as const,
 *     refCb: (db, docId: string) => db.collection("users").doc(docId),
 *   }),
 *   posts: createRepositoryConfig<PostModel>()({
 *     path: "posts",
 *     foreignKeys: ["docId", "userId"] as const,
 *     queryKeys: ["status"] as const,
 *     refCb: (db, docId: string) => db.collection("posts").doc(docId),
 *   }).withRelations<typeof mapping>()({
 *     userId: { repo: "users", key: "docId", type: "one" as const }
 *   })
 * };
 * ```
 */
export function createRepositoryConfig<T>() {
  return <
    const TForeignKeys extends readonly (keyof T)[],
    const TQueryKeys extends readonly (keyof T)[],
    const TIsGroup extends boolean,
    const TDocumentKey extends keyof T,
    const TPathKey extends keyof T | undefined = undefined,
    const TCreatedKey extends keyof T | undefined = undefined,
    const TUpdatedKey extends keyof T | undefined = undefined,
    TRefCb = undefined
  >(config: {
    path: string;
    isGroup: TIsGroup;
    foreignKeys: TForeignKeys;
    queryKeys: TQueryKeys;
    documentKey: TDocumentKey;
    pathKey?: TPathKey;
    createdKey?: TCreatedKey;
    updatedKey?: TUpdatedKey;
    refCb: TRefCb;
  }): RepositoryConfig<
    T,
    TForeignKeys,
    TQueryKeys,
    TIsGroup,
    TRefCb,
    {},
    TDocumentKey,
    TPathKey,
    TCreatedKey,
    TUpdatedKey
  > => {
    return {
      ...config,
      type: null as any as T,
      documentRef: null as any,
      update: null as any,
    } as any;
  };
}

/**
 * Helper type to resolve a single relation configuration
 * Extracts the target model type from the mapping
 */
type ResolveRelation<TMapping, TRelationConfig> = TRelationConfig extends {
  repo: infer R;
  key: infer FK;
  type: infer RT;
}
  ? R extends keyof TMapping
    ? TMapping[R] extends { type: infer TTarget }
      ? RelationConfig<R & string, FK & string, RT & ("one" | "many"), TTarget>
      : never
    : never
  : never;

/**
 * Helper to add relations to a repository mapping with full type validation
 * Validates that repo names and foreign keys exist in the mapping
 * @template TMapping - The complete repository mapping for validation
 * @template TRelations - Relations configuration with strict typing
 * @param mapping - The base repository mapping
 * @param relations - Relations configuration for each repository
 * @returns Updated mapping with relations and full type safety
 * @example
 * ```typescript
 * const mapping = {
 *   users: createRepositoryConfig<UserModel>()({ ... }),
 *   posts: createRepositoryConfig<PostModel>()({ ... }),
 * };
 *
 * const mappingWithRelations = buildRepositoryRelations(mapping, {
 *   posts: {
 *     userId: { repo: "users", key: "docId", type: "one" as const }
 *   }
 * });
 *
 * const repos = createRepositoryMapping(db, mappingWithRelations);
 * ```
 */
export function buildRepositoryRelations<
  TMapping extends Record<string, any>,
  const TRelations extends {
    [K in keyof TMapping]?: TMapping[K] extends RepositoryConfig<
      infer T,
      any,
      any,
      any,
      any,
      any,
      any,
      any,
      any,
      any
    >
      ? {
          [RK in keyof T]?: {
            [R in keyof TMapping]: TMapping[R] extends RepositoryConfig<
              infer TTargetModel,
              infer TForeignKeys,
              any,
              any,
              any,
              any,
              any,
              any,
              any,
              any
            >
              ? {
                  repo: R;
                  key: TForeignKeys[number];
                  type: "one" | "many";
                }
              : never;
          }[keyof TMapping];
        }
      : never;
  }
>(
  mapping: TMapping,
  relations: TRelations
): {
  [K in keyof TMapping]: K extends keyof TRelations
    ? TMapping[K] extends RepositoryConfig<
        infer T,
        infer TForeignKeys,
        infer TQueryKeys,
        infer TIsGroup,
        infer TRefCb,
        any,
        infer TDocumentKey,
        infer TPathKey,
        infer TCreatedKey,
        infer TUpdatedKey
      >
      ? RepositoryConfig<
          T,
          TForeignKeys,
          TQueryKeys,
          TIsGroup,
          TRefCb,
          {
            [RK in keyof TRelations[K]]: ResolveRelation<
              TMapping,
              TRelations[K][RK]
            >;
          },
          TDocumentKey,
          TPathKey,
          TCreatedKey,
          TUpdatedKey
        >
      : TMapping[K]
    : TMapping[K];
} {
  const result: any = { ...mapping };

  for (const repoKey in relations) {
    if (relations[repoKey]) {
      result[repoKey] = {
        ...mapping[repoKey],
        relationalKeys: relations[repoKey],
      };
    }
  }

  return result as any;
}

// ============================================
// Repository Mapping Class
// ============================================

/**
 * Repository mapping class that manages Firestore repositories with type safety
 * @template T - Record of repository configurations
 */
export class RepositoryMapping<T extends Record<string, any>> {
  private db: Firestore;
  private repositoryCache = new Map<string, any>();
  private mapping: T;
  private allRepositories: Record<string, any> = {};

  /**
   * Creates a new RepositoryMapping instance
   * @param db - Firestore instance from firebase-admin
   * @param mapping - Repository configuration mapping
   */
  constructor(db: Firestore, mapping: T) {
    this.db = db;
    this.mapping = mapping;
    // Pre-initialize all repositories to allow cross-references
    this.initializeRepositories();
  }

  /**
   * Initialize all repositories in two passes to handle circular dependencies
   * @private
   */
  private initializeRepositories() {
    // Pass 1: Create all repositories without populate methods
    for (const key of Object.keys(this.mapping)) {
      this.allRepositories[key] = createRepository(
        this.db,
        this.mapping[key],
        {}
      );
    }

    // Pass 2: Update all repositories with complete allRepositories map
    for (const key of Object.keys(this.mapping)) {
      this.allRepositories[key] = createRepository(
        this.db,
        this.mapping[key],
        this.allRepositories
      );
    }
  }

  /**
   * Gets a repository (already initialized)
   * @template K - Repository key
   * @param key - Repository identifier
   * @returns Configured repository instance
   */
  getRepository<K extends keyof T>(key: K): ConfiguredRepository<T[K]> {
    return this.allRepositories[key as string];
  }
}

// ============================================
// Repository Mapping Factory
// ============================================

/**
 * Helper function to create a RepositoryMapping instance with full typing
 * @template T - Record of repository configurations
 * @param db - Firestore instance from firebase-admin
 * @param mapping - Repository configurations
 * @returns RepositoryMapping instance with repository access via getters
 * @example
 * ```typescript
 * import * as admin from 'firebase-admin';
 *
 * admin.initializeApp();
 * const db = admin.firestore();
 *
 * const repos = createRepositoryMapping(db, {
 *   users: createRepositoryConfig<UserModel>()({
 *     path: "users",
 *     isGroup: false,
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["isActive"] as const,
 *     refCb: (db, docId: string) => db.collection("users").doc(docId),
 *   }),
 * });
 *
 * // Access repositories directly
 * const user = await repos.users.get.byDocId("123");
 * ```
 */
export function createRepositoryMapping<T extends Record<string, any>>(
  db: Firestore,
  mapping: T
): RepositoryMapping<T> & { [K in keyof T]: ConfiguredRepository<T[K]> } {
  const instance = new RepositoryMapping(db, mapping);

  // Create a Proxy to dynamically generate getters
  return new Proxy(instance, {
    get(target, prop) {
      if (typeof prop === "string" && prop in mapping) {
        return target.getRepository(prop as keyof T);
      }
      return (target as any)[prop];
    },
  }) as any;
}
