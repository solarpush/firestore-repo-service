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
 * @example
 * ```typescript
 * const condition: WhereClause<EventModel> = {
 *   field: 'status',
 *   operator: '==',
 *   value: 'signed'
 * }
 * ```
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
 *
 * @property {WhereClause<T>[]} [where] - AND conditions
 * @property {WhereClause<T>[][]} [orWhere] - OR conditions (array of AND groups)
 * @property {Array<{field: keyof T; direction?: "asc" | "desc"}>} [orderBy] - Sort criteria
 * @property {number} [limit] - Maximum number of results to return
 * @property {number} [offset] - Number of results to skip (pagination)
 *
 * @example
 * // Simple AND search
 * ```typescript
 * const options: QueryOptions<EventModel> = {
 *   where: [
 *     { field: 'status', operator: '==', value: 'signed' },
 *     { field: 'dateTime', operator: '>=', value: startDate }
 *   ],
 *   orderBy: [{ field: 'dateTime', direction: 'desc' }],
 *   limit: 10
 * }
 * ```
 *
 * @example
 * // OR search: (status == 'draft' AND userId == '123') OR (status == 'published')
 * ```typescript
 * const options: QueryOptions<EventModel> = {
 *   orWhere: [
 *     [
 *       { field: 'status', operator: '==', value: 'draft' },
 *       { field: 'userId', operator: '==', value: '123' }
 *     ],
 *     [
 *       { field: 'status', operator: '==', value: 'published' }
 *     ]
 *   ]
 * }
 * ```
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
 * Configuration interface for repositories with strict literal type inference
 * @template T - The data model type
 * @template TForeignKeys - Foreign keys used for unique document retrieval (get methods)
 * @template TQueryKeys - Query keys used for multiple document searches (query methods)
 * @template TIsGroup - Whether this is a collection group query
 * @template TRefCb - Callback function signature for creating document references
 */
export interface RepositoryConfig<
  T,
  TForeignKeys extends readonly (keyof T)[],
  TQueryKeys extends readonly (keyof T)[],
  TIsGroup extends boolean = boolean,
  TRefCb = any
> {
  /** Firestore collection path */
  path: string;
  /** Whether this is a collection group query */
  isGroup: TIsGroup;
  /** Keys used for unique document retrieval (generates get.by* methods) */
  foreignKeys: TForeignKeys;
  /** Keys used for querying multiple documents (generates query.by* methods) */
  queryKeys: TQueryKeys;
  /** Type definition for the data model */
  type: T;
  /** Callback to construct document reference */
  refCb?: TRefCb;
  /** Exposes the same signature as refCb but without the db parameter */
  documentRef: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...pathSegments: string[]) => DocumentReference
      : (docId: string) => DocumentReference
    : ExtractDocumentRefSignature<TRefCb>;
  /** Exposes the same signature as refCb but with data parameter and returns the updated object */
  update: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...args: [...string[], Partial<T>]) => Promise<T>
      : (docId: string, data: Partial<T>) => Promise<T>
    : ExtractUpdateSignature<TRefCb, T>;
}
