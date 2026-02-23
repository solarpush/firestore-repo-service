import type { z } from "zod";
import type { PaginationResult } from "../../src/pagination";
import type { ConfiguredRepository } from "../../src/repositories/types";
import type { RepositoryConfig } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Extract the model type T from a ConfiguredRepository
 * @internal
 */
export type ExtractRepoModel<TRepo> =
  TRepo extends ConfiguredRepository<
    RepositoryConfig<infer T, any, any, any, any, any, any, any, any, any>
  >
    ? T
    : never;

/**
 * Extract relational keys from a ConfiguredRepository
 * @internal
 */
export type ExtractRelationalKeys<TRepo> =
  TRepo extends ConfiguredRepository<
    RepositoryConfig<
      any,
      any,
      any,
      any,
      any,
      infer TRelationalKeys,
      any,
      any,
      any,
      any
    >
  >
    ? TRelationalKeys
    : {};

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/**
 * Parsed pagination request body sent by the client
 */
export interface PaginationRequestBody {
  /** Number of items per page (default: 20) */
  pageSize?: number;
  /** Opaque cursor string returned by the previous page */
  cursor?: string;
  /** Direction of pagination */
  direction?: "next" | "prev";
  /** Array of where clauses: [field, operator, value] */
  where?: [string, string, unknown][];
  /** Order-by clauses */
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  /** Fields to select (reduces network transfer) */
  select?: string[];
  /**
   * Relation keys to include.
   * Each entry is either a relation key (string) or a typed include config.
   */
  includes?: (string | { relation: string; select?: string[] })[];
}

/**
 * Validated pagination options after schema parsing
 */
export type ValidatedPaginationRequest = Required<
  Pick<PaginationRequestBody, "pageSize">
> &
  Omit<PaginationRequestBody, "pageSize">;

// ---------------------------------------------------------------------------
// Options for createPaginationFunction
// ---------------------------------------------------------------------------

/**
 * Options passed to `createPaginationFunction`
 * @template TModel - The data model type for the target repo
 */
export interface PaginationFunctionOptions<TModel> {
  /**
   * Zod schema used to validate the **filter / query** part of the request.
   * This schema must be a subset of (or equal to) the repo's model type.
   *
   * @example
   * // Given: type Post = { status: string; authorId: string; ... }
   * schema: z.object({
   *   status: z.string().optional(),
   *   authorId: z.string().optional(),
   * })
   */
  schema: z.ZodType<Partial<TModel>>;

  /** Default page size when not provided by the client (default: 20) */
  defaultPageSize?: number;

  /** Maximum page size allowed (default: 100) */
  maxPageSize?: number;

  /**
   * Whether to allow the client to specify `includes` for relation population.
   * When false, all include requests are ignored (default: true).
   */
  allowIncludes?: boolean;

  /**
   * Allowed relation keys the client can request via `includes`.
   * When set, any key not in this list is silently dropped.
   */
  allowedIncludes?: string[];

  /**
   * CORS origins to allow (default: "*")
   * Pass `false` to disable CORS headers entirely.
   */
  cors?: string | false;
}

// ---------------------------------------------------------------------------
// Serialisable cursor
// ---------------------------------------------------------------------------

/**
 * A cursor that can be passed over HTTP (base64-encoded JSON)
 * The actual Firestore DocumentSnapshot is never serialised across the wire;
 * instead we encode the ordered values used by `startAfter`.
 */
export interface SerializedCursor {
  /** Ordered field values that correspond to the orderBy clause */
  values: unknown[];
  /** Document ID as tiebreaker */
  docId: string;
}

// ---------------------------------------------------------------------------
// Handler result
// ---------------------------------------------------------------------------

export interface PaginationHttpResult<T> {
  data: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  pageSize: number;
}

export function serializePaginationResult<T>(
  result: PaginationResult<T>,
): PaginationHttpResult<T> {
  const encodeCursor = (
    snap: import("firebase-admin/firestore").DocumentSnapshot | undefined,
  ): string | null => {
    if (!snap) return null;
    try {
      const data = snap.data() ?? {};
      const payload: SerializedCursor = {
        values: Object.values(data),
        docId: snap.id,
      };
      return Buffer.from(JSON.stringify(payload)).toString("base64url");
    } catch {
      return null;
    }
  };

  return {
    data: result.data,
    nextCursor: encodeCursor(result.nextCursor),
    prevCursor: encodeCursor(result.prevCursor),
    hasNextPage: result.hasNextPage,
    hasPrevPage: result.hasPrevPage,
    pageSize: result.pageSize,
  };
}
