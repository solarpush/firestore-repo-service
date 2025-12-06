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
 * Check if a type is a plain object (not Date, Array, Function, etc.)
 * @internal
 */
type IsPlainObject<T> = T extends Date
  ? false
  : T extends Array<any>
  ? false
  : T extends Function
  ? false
  : T extends object
  ? true
  : false;

/**
 * Recursively generates dot-notation paths for nested plain objects only
 * Stops at primitives, Date, Array, Function, etc.
 * @template T - The object type to traverse
 * @template Prefix - Current path prefix
 * @template Depth - Recursion depth limit
 * @example
 * type User = { address: { city: string; zip: number }; createdAt: Date }
 * // NestedPaths<User> = "address" | "address.city" | "address.zip" | "createdAt"
 */
type NestedPaths<
  T,
  Prefix extends string = "",
  Depth extends number[] = []
> = Depth["length"] extends 5
  ? Prefix
  : {
      [K in keyof T & string]: IsPlainObject<T[K]> extends true
        ? Prefix extends ""
          ? K | NestedPaths<T[K], K, [...Depth, 1]>
          :
              | `${Prefix}.${K}`
              | NestedPaths<T[K], `${Prefix}.${K}`, [...Depth, 1]>
        : Prefix extends ""
        ? K
        : `${Prefix}.${K}`;
    }[keyof T & string];

/**
 * Gets the type at a dot-notation path
 * @template T - The object type
 * @template Path - The dot-notation path string
 * @example
 * type User = { address: { city: string } }
 * // PathValue<User, "address.city"> = string
 */
type PathValue<
  T,
  Path extends string
> = Path extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? PathValue<T[Key], Rest>
    : never
  : Path extends keyof T
  ? T[Path]
  : never;

/**
 * All possible field paths including nested paths
 * @template T - Data model type
 */
export type FieldPath<T> = NestedPaths<T>;

/**
 * Type for a where condition as a tuple [field, operator, value]
 * Supports dot-notation for nested fields with proper value typing
 * @template T - Data model type
 * @example
 * // For type User = { name: string; address: { city: string } }
 * // Valid: ["name", "==", "John"]
 * // Valid: ["address.city", "==", "Paris"]
 */
export type WhereClause<T = any> = {
  [P in FieldPath<T>]: [P, WhereFilterOp, PathValue<T, P> | PathValue<T, P>[]];
}[FieldPath<T>];

/**
 * Query options for filtering, sorting and paginating results
 * @template T - Data model type
 */
export interface QueryOptions<T = any> {
  where?: WhereClause<T>[];
  orWhere?: WhereClause<T>[][];
  orderBy?: { field: FieldPath<T>; direction?: "asc" | "desc" }[];
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
 * @template TTargetModel - Type of the target model (inferred from mapping)
 */
export interface RelationConfig<
  TRepoKey extends string = string,
  TForeignKey extends string = string,
  TType extends "one" | "many" = "one" | "many",
  TTargetModel = any
> {
  repo: TRepoKey;
  key: TForeignKey;
  type: TType;
  targetType?: TTargetModel;
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
 * @template TDocumentKey - The field name to store the document ID
 * @template TPathKey - The field name to store the document path (optional)
 */
export interface RepositoryConfig<
  T,
  TForeignKeys extends readonly (keyof T)[],
  TQueryKeys extends readonly (keyof T)[],
  TIsGroup extends boolean = boolean,
  TRefCb = any,
  TRelationalKeys = {},
  TDocumentKey extends keyof T = keyof T,
  TPathKey extends keyof T | undefined = undefined
> {
  path: string;
  isGroup: TIsGroup;
  foreignKeys: TForeignKeys;
  queryKeys: TQueryKeys;
  documentKey: TDocumentKey;
  pathKey?: TPathKey;
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
