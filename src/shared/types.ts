/* eslint-disable @typescript-eslint/no-empty-object-type */

import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  WhereFilterOp,
} from "firebase-admin/firestore";

/**
 * Extract the documentRef signature from refCb (without the db parameter)
 * @internal
 */
export type ExtractDocumentRefSignature<T> = T extends (
  db: Firestore,
  ...args: infer P
) => DocumentReference
  ? (...args: P) => DocumentReference
  : never;

/**
 * Extract the update signature from refCb
 * @internal
 */
export type ExtractUpdateSignature<T, TType> = T extends (
  db: Firestore,
  ...args: infer P
) => DocumentReference
  ? (...args: [...P, Partial<TType>]) => Promise<TType>
  : never;

/**
 * Type for a where condition with strict value typing based on the field
 * @template T - Data model type
 */
export type WhereClause<T = any> = {
  [K in keyof T]: {
    field: K;
    operator: WhereFilterOp;
    value: T[K] | T[K][];
  };
}[keyof T];

/**
 * Query options for filtering, sorting and paginating results
 * @template T - Data model type
 */
export interface QueryOptions<T = any> {
  where?: WhereClause<T>[];
  orWhere?: WhereClause<T>[][];
  orderBy?: { field: keyof T; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  startAt?: DocumentSnapshot | any[];
  startAfter?: DocumentSnapshot | any[];
  endAt?: DocumentSnapshot | any[];
  endBefore?: DocumentSnapshot | any[];
}

/**
 * Result type for get operations with optional document snapshot
 * @internal
 */
export type GetResult<T, ReturnDoc extends boolean> = ReturnDoc extends true
  ? { data: T; doc: DocumentSnapshot } | null
  : T | null;

/**
 * Relation configuration for a field with strict typing
 * @template TRepoKey - Target repository name (key from mapping)
 * @template TForeignKey - Target foreign key name
 * @template TType - Relation type: "one" for one-to-one, "many" for one-to-many
 */
export interface RelationConfig<
  TRepoKey extends string = string,
  TForeignKey extends string = string,
  TType extends "one" | "many" = "one" | "many"
> {
  repo: TRepoKey;
  key: TForeignKey;
  type: TType;
}

/**
 * Relational key mapping between repositories with strict typing
 * Maps a field from the current model to a target repository and foreign key
 * @template T - Current model type
 * @template TMapping - All repositories mapping for validation
 * @example { userId: { repo: "users", key: "docId", type: "one" } }
 *
 * IMPORTANT: Keys must exist in T (the current model)
 * This prevents creating relations on non-existent fields
 */
export type RelationalKeys<T = any, TMapping = any> = {
  [K in keyof T]?: TMapping extends Record<string, any>
    ? {
        [R in keyof TMapping]: TMapping[R] extends RepositoryConfig<
          any,
          infer FKeys,
          any,
          any,
          any,
          any
        >
          ? {
              repo: R;
              key: FKeys[number];
              type: "one" | "many";
            }
          : never;
      }[keyof TMapping]
    : RelationConfig;
};

/**
 * Configuration interface for repositories with strict literal type inference
 * @template T - The data model type
 * @template TForeignKeys - Foreign keys used for unique document retrieval
 * @template TQueryKeys - Query keys used for multiple document searches
 * @template TIsGroup - Whether this is a collection group query
 * @template TRefCb - Callback function signature for creating document references
 * @template TRelationalKeys - Relational keys mapping to other repositories
 */
export interface RepositoryConfig<
  T,
  TForeignKeys extends readonly (keyof T)[],
  TQueryKeys extends readonly (keyof T)[],
  TIsGroup extends boolean = boolean,
  TRefCb = any,
  TRelationalKeys extends RelationalKeys<T> = {}
> {
  path: string;
  isGroup: TIsGroup;
  foreignKeys: TForeignKeys;
  queryKeys: TQueryKeys;
  type: T;
  refCb?: TRefCb;
  relationalKeys?: TRelationalKeys;
  documentRef: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...pathSegments: string[]) => DocumentReference
      : (docId: string) => DocumentReference
    : ExtractDocumentRefSignature<TRefCb>;
  update: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...args: [...string[], Partial<T>]) => Promise<T>
      : (docId: string, data: Partial<T>) => Promise<T>
    : ExtractUpdateSignature<TRefCb, T>;
}
