/* eslint-disable @typescript-eslint/no-empty-object-type */

import type { Firestore } from "firebase-admin/firestore";

// ============================================
// Re-exports from modules
// ============================================

// Shared types
export type {
  ExtractDocumentRefSignature,
  ExtractUpdateSignature,
  GetResult,
  QueryOptions,
  RelationConfig,
  RelationalKeys,
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
 * @template T - The data model type
 * @template TForeignKeys - Readonly array of foreign keys
 * @template TQueryKeys - Readonly array of query keys
 * @template TIsGroup - Boolean indicating if it's a collection group
 * @template TRefCb - Type of the reference callback function
 * @param config - Repository configuration object
 * @returns Configured repository with typed methods
 * @example
 * ```typescript
 * const usersRepo = createRepositoryConfig({
 *   path: "users",
 *   isGroup: false,
 *   foreignKeys: ["docId", "email"] as const,
 *   queryKeys: ["isActive"] as const,
 *   type: {} as UserModel,
 *   refCb: (db, docId: string) => db.collection("users").doc(docId),
 * });
 * ```
 */
export function createRepositoryConfig<
  T,
  const TForeignKeys extends readonly (keyof T)[],
  const TQueryKeys extends readonly (keyof T)[],
  const TIsGroup extends boolean,
  TRefCb = undefined,
  const TRelationalKeys extends {
    [K in keyof TRelationalKeys]: K extends keyof T ? RelationConfig : never;
  } = {}
>(config: {
  path: string;
  isGroup: TIsGroup;
  foreignKeys: TForeignKeys;
  queryKeys: TQueryKeys;
  type: T;
  refCb: TRefCb;
  relationalKeys?: TRelationalKeys;
}): RepositoryConfig<
  T,
  TForeignKeys,
  TQueryKeys,
  TIsGroup,
  TRefCb,
  TRelationalKeys
> {
  return {
    ...config,
    documentRef: null as any, // Will be created in factory
    update: null as any, // Will be created in factory
  } as any;
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
 *   users: createRepositoryConfig({
 *     path: "users",
 *     isGroup: false,
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["isActive"] as const,
 *     type: {} as UserModel,
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
