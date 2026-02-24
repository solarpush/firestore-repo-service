/**
 * Type definitions for the CRUD API server.
 */

import type { z } from "zod";
import type { ConfiguredRepository } from "../../repositories/types";
import type { FieldPath, RepositoryConfig } from "../../shared/types";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Extracts the model type `T` from a `ConfiguredRepository`.
 * @internal
 */
export type RepoModelType<TRepo> =
  TRepo extends ConfiguredRepository<
    RepositoryConfig<infer T, any, any, any, any, any, any, any, any, any>
  >
    ? T
    : never;

/**
 * Configuration for a single repository in the CRUD server.
 *
 * @template TRepo - The `ConfiguredRepository` type; used to derive typed field names.
 */
export interface CrudRepoConfig<
  TRepo extends ConfiguredRepository<any> = ConfiguredRepository<any>,
> {
  /** The configured repository instance. Drives type inference for all other fields. */
  repo: TRepo;
  /**
   * Zod schema — required when the repo was not created with `createRepositoryConfig(schema)`.
   * Used for request validation.
   */
  schema?: z.ZodObject<z.ZodRawShape>;
  /** Firestore collection path (for routing) */
  path: string;
  /** Key used to identify documents (default: "docId") */
  documentKey?: string;
  /** Number of documents per page in list endpoint (default: 25) */
  pageSize?: number;
  /**
   * Fields that can be used for filtering via query params.
   * Defaults to all schema keys.
   */
  filterableFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Fields allowed in update requests — typed to the model keys.
   * If unset, all schema fields are allowed.
   */
  mutableFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Fields allowed in create requests — typed to the model keys.
   * If unset, all schema fields are allowed.
   */
  createFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Whether DELETE endpoint is enabled.
   * Default: false — delete is disabled unless explicitly set to true.
   */
  allowDelete?: boolean;
  /**
   * Allowed relation keys the client can request via `includes`.
   * When set, any key not in this list is silently dropped.
   * If not set, includes are disabled.
   */
  allowedIncludes?: string[];
  /**
   * Custom validation function called before create/update.
   * Return an error message string to reject, or undefined to accept.
   */
  validate?: (
    data: Partial<RepoModelType<TRepo>>,
    operation: "create" | "update",
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * Internal repo entry for the CRUD server.
 */
export interface CrudRepoEntry {
  name: string;
  path: string;
  repo: ConfiguredRepository<
    RepositoryConfig<any, any, any, any, any, any, any, any, any, any>
  >;
  schema: z.ZodObject<z.ZodRawShape>;
  documentKey: string;
  pageSize: number;
  filterableFields?: string[];
  mutableFields?: string[];
  createFields?: string[];
  allowDelete: boolean;
  allowedIncludes?: string[];
  validate?: (
    data: any,
    operation: "create" | "update",
  ) => string | undefined | Promise<string | undefined>;
}

export type CrudRepoRegistry = Record<string, CrudRepoEntry>;

/**
 * HTTP Basic Auth configuration.
 */
export interface BasicAuthConfig {
  type: "basic";
  /** Realm displayed in the browser login dialog */
  realm?: string;
  username: string;
  password: string;
}

/**
 * Middleware function type
 */
export type Middleware = (
  req: any,
  res: any,
  next: () => void | Promise<void>,
) => void | Promise<void>;

/**
 * Options for `createCrudServer`.
 *
 * @template TRepos - Shape of the repos map (inferred automatically at the call site)
 */
export interface CrudServerOptions<
  TRepos extends Record<string, ConfiguredRepository<any>> = Record<
    string,
    ConfiguredRepository<any>
  >,
> {
  /**
   * Base URL path of the function (e.g. "/api").
   * Must match the path where the Firebase Function is mounted.
   * Default: "/"
   */
  basePath?: string;

  /**
   * Repository entries keyed by a name (used as route prefix).
   *
   * @example
   * ```ts
   * repos: {
   *   posts: {
   *     repo: repos.posts,
   *     path: "posts",
   *     filterableFields: ["status", "userId"],
   *     mutableFields: ["title", "content"],
   *     createFields: ["title", "content", "status"],
   *     allowDelete: true,
   *   },
   * }
   * ```
   */
  repos: { [K in keyof TRepos]: CrudRepoConfig<TRepos[K]> };

  /** Whether to parse JSON bodies. Default: true. */
  parseBody?: boolean;

  /**
   * Authentication guard executed before every request.
   * - Pass a `BasicAuthConfig` to enable HTTP Basic Auth.
   * - Pass a `Middleware` function for custom auth logic.
   */
  auth?: BasicAuthConfig | Middleware;

  /**
   * Additional middleware functions executed after auth, before route handlers.
   */
  middleware?: Middleware[];

  /**
   * Whether to include detailed error messages in responses.
   * Default: false (production-safe).
   */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Standard API response wrapper.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
    hasMore?: boolean;
    cursor?: string | null;
  };
}

/**
 * List response data.
 */
export interface ListResponseData<T = unknown> {
  items: T[];
  /** Cursor for next page (null if none) */
  nextCursor?: Record<string, unknown> | null;
  /** Cursor for previous page (null if none) */
  prevCursor?: Record<string, unknown> | null;
  /** Whether there is a next page */
  hasNextPage: boolean;
  /** Whether there is a previous page */
  hasPrevPage: boolean;
}

/**
 * Query request body for POST /query endpoint.
 * Supports advanced filtering with OR conditions.
 */
export interface QueryRequestBody {
  /**
   * AND conditions: all must match.
   * @example [["status", "==", "published"], ["views", ">=", 100]]
   */
  where?: [string, string, unknown][];
  /**
   * Simple OR: each clause is independently OR'd.
   * Base `where` conditions are applied to every OR branch.
   * @example [["status", "==", "draft"], ["status", "==", "published"]]
   */
  orWhere?: [string, string, unknown][];
  /**
   * Advanced OR groups: each group is AND'd internally, groups are OR'd.
   * Base `where` conditions are applied to every group.
   * @example [[["type", "==", "A"], ["active", "==", true]], [["type", "==", "B"]]]
   */
  orWhereGroups?: [string, string, unknown][][];
  /**
   * Order by fields.
   * @example [{ "field": "createdAt", "direction": "desc" }]
   */
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  /**
   * Fields to select (projection).
   * @example ["title", "status", "createdAt"]
   */
  select?: string[];
  /**
   * Number of items per page (max 100).
   * @default 25
   */
  pageSize?: number;
  /**
   * Cursor for pagination (JSON object or stringified JSON).
   */
  cursor?: string | Record<string, unknown>;
  /**
   * Direction of pagination (default: "next").
   */
  direction?: "next" | "prev";
  /**
   * Relations to include (populate).
   * Each entry is either a relation key (string) or a config object.
   * @example ["author", { "relation": "comments", "select": ["text"] }]
   */
  includes?: (string | { relation: string; select?: string[] })[];
}
