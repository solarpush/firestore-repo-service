/**
 * Type definitions for the CRUD API server.
 */

import type { z } from "zod";
import type { ConfiguredRepository } from "../../repositories/types";
import type { FieldPath, RepositoryConfig } from "../../shared/types";
import type { OpenAPISpecOptions } from "./openapi";

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
 * Extracts the auto-managed system keys (documentKey, pathKey, createdKey, updatedKey)
 * from a `ConfiguredRepository`. These keys must never appear in create/update payloads.
 * @internal
 */
export type RepoSystemKeys<TRepo> =
  TRepo extends ConfiguredRepository<
    RepositoryConfig<
      any,
      any,
      any,
      any,
      any,
      any,
      infer TDocKey,
      infer TPathKey,
      infer TCreatedKey,
      infer TUpdatedKey
    >
  >
    ?
        | (TDocKey extends string ? TDocKey : never)
        | (TPathKey extends string ? TPathKey : never)
        | (TCreatedKey extends string ? TCreatedKey : never)
        | (TUpdatedKey extends string ? TUpdatedKey : never)
    : never;

/**
 * `true` when `T` is `any`  (the `0 extends (1 & T)` trick).
 * @internal
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Allowed roles for a field in `fieldsConfig`.
 * - `"create"` — field is accepted in create requests / create form
 * - `"mutable"` — field is accepted in update requests / edit form
 * - `"filterable"` — field can be used in query filters / filter bar
 */
export type FieldRole = "create" | "mutable" | "filterable";

/**
 * Field paths on the model, **excluding** auto-managed system keys.
 * Falls back to `string` when `TRepo` is unresolved (`any`) so that plain
 * `createCrudServer({ repos: { … } })` usage doesn't produce `never[]` errors.
 * Full autocomplete is available once `TRepo` is fully inferred.
 * @internal
 */
export type UserFieldPath<TRepo> =
  IsAny<TRepo> extends true
    ? string
    : IsAny<RepoModelType<TRepo>> extends true
      ? string
      : FieldPath<Omit<RepoModelType<TRepo>, RepoSystemKeys<TRepo>>>;

/**
 * All field paths on the model (including system keys), with `any` guard.
 * Used for `filterableFields` where system-key fields are valid.
 * @internal
 */
export type RepoFieldPath<TRepo> =
  IsAny<TRepo> extends true
    ? string
    : IsAny<RepoModelType<TRepo>> extends true
      ? string
      : FieldPath<RepoModelType<TRepo>>;

/**
 * Extracts the relational-key names from a `ConfiguredRepository`.
 * Falls back to `string` when `TRepo` is unresolved (`any`).
 * @internal
 */
export type RepoRelationKeys<TRepo> =
  IsAny<TRepo> extends true
    ? string
    : TRepo extends ConfiguredRepository<
          RepositoryConfig<
            any,
            any,
            any,
            any,
            any,
            infer TRelKeys,
            any,
            any,
            any,
            any
          >
        >
      ? IsAny<TRelKeys> extends true
        ? string
        : keyof TRelKeys & string
      : string;

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
  schema?: z.ZodObject<any>;
  /** Firestore collection path (for routing) */
  path: string;
  /** Key used to identify documents (default: "docId") */
  documentKey?: string;
  /** Number of documents per page in list endpoint (default: 25) */
  pageSize?: number;
  /**
   * Per-field role configuration.
   * Each key is a model field (with autocomplete); the value is an array of roles.
   * Object keys are inherently unique — no duplicate field entries possible.
   *
   * Roles:
   * - `"create"` — field is accepted in create requests
   * - `"mutable"` — field is accepted in update requests (PUT/PATCH)
   * - `"filterable"` — field can be used in query filters
   *
   * If `fieldsConfig` is omitted, all non-system schema fields are allowed
   * for all roles, and all fields (including system keys) are filterable.
   *
   * @example
   * ```ts
   * fieldsConfig: {
   *   title:   ["create", "mutable", "filterable"],
   *   content: ["create", "mutable"],
   *   status:  ["create", "filterable"],
   *   userId:  ["filterable"],
   * }
   * ```
   */
  fieldsConfig?: Partial<Record<RepoFieldPath<TRepo>, readonly FieldRole[]>>;
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
  allowedIncludes?: readonly RepoRelationKeys<TRepo>[];
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
  schema: z.ZodObject<any>;
  /** Keys automatically managed by Firestore (docId, path, timestamps) — excluded from create/update payloads */
  systemKeys: string[];
  documentKey: string;
  pageSize: number;
  /** Resolved from fieldsConfig: fields with role "filterable" */
  filterableFields?: string[];
  /** Resolved from fieldsConfig: fields with role "mutable" */
  mutableFields?: string[];
  /** Resolved from fieldsConfig: fields with role "create" */
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
 * Made generic so TypeScript can infer the model type of each repo entry
 * and provide autocomplete + type-checking on `filterableFields`, `mutableFields`,
 * `createFields`, and `allowedIncludes`.
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
   * TypeScript infers the model type from each `repo` field,
   * so `fieldsConfig` keys and `allowedIncludes` are typed to that model.
   *
   * @example
   * ```ts
   * repos: {
   *   posts: {
   *     repo: repos.posts,
   *     path: "posts",
   *     fieldsConfig: {
   *       title:   ["create", "mutable", "filterable"],
   *       content: ["create", "mutable"],
   *       status:  ["create", "filterable"],
   *       userId:  ["filterable"],
   *     },
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

  /**
   * OpenAPI documentation options.
   * Set to `false` to disable spec generation & doc endpoints entirely.
   * When unset or an object, `/__spec.json` and `/__docs` routes are exposed.
   */
  openapi?: OpenAPISpecOptions | false;
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
