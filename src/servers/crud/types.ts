/**
 * Type definitions for the CRUD API server.
 */

import type { z } from "zod";
import type { HttpsOptions } from "firebase-functions/v2/https";
import type { ConfiguredRepository } from "../../repositories/types";
import type { FieldPath, RepositoryConfig } from "../../shared/types";
import type { HonoServerOptions } from "../hono/types";

// ---------------------------------------------------------------------------
// OpenAPI options
// ---------------------------------------------------------------------------

/**
 * Options to control OpenAPI 3.1 spec generation for the CRUD server.
 * Defined here (rather than in `./openapi`) to avoid a circular import:
 * `openapi.ts` imports types from this module.
 */
export interface OpenAPISpecOptions {
  /** Document title (default: "CRUD API") */
  title?: string;
  /** API version (default: "1.0.0") */
  version?: string;
  /** Description shown in Scalar UI / Swagger */
  description?: string;
  /** Server URLs */
  servers?: { url: string; description?: string }[];
  /** Whether the API requires auth — adds securitySchemes */
  auth?: "basic" | "bearer" | false;
  /** Path served by the JSON spec (e.g. `/openapi.json`). Default: `/openapi.json`. */
  path?: string;
  /** Path serving the documentation UI. Set to `false` to disable. Default: `/docs`. */
  docsPath?: string | false;
  /** Auth guards for the docs UI (same as HonoServer DocsAuthExtension or middleware) */
  docsAuth?: import("../hono/types").OpenAPIConfig["docsAuth"];
}

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Extracts the model type `T` from a `ConfiguredRepository`.
 * Uses a two-step inference so it survives intersection types
 * (e.g. `RepositoryConfig<...> & { schema: ZodObject }` produced by
 * `createRepositoryConfig(schema)`).
 * @internal
 */
export type RepoModelType<TRepo> =
  TRepo extends ConfiguredRepository<infer C>
    ? C extends RepositoryConfig<
    infer T,
    any,
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
      ? T
      : never
    : never;

/**
 * Extracts the auto-managed system keys (documentKey, pathKey, createdKey, updatedKey)
 * from a `ConfiguredRepository`. These keys must never appear in create/update payloads.
 * @internal
 */
export type RepoSystemKeys<TRepo> =
  TRepo extends ConfiguredRepository<infer C>
    ? C extends RepositoryConfig<
        any,
        any,
        any,
        any,
        any,
        any,
        infer TDocKey,
        infer TPathKey,
        infer TCreatedKey,
        infer TUpdatedKey,
        any
      >
      ?
          | (TDocKey extends string ? TDocKey : never)
          | (TPathKey extends string ? TPathKey : never)
          | (TCreatedKey extends string ? TCreatedKey : never)
          | (TUpdatedKey extends string ? TUpdatedKey : never)
      : never
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
 * - `"orderable"` — field can be used in `orderBy` / sort
 */
export type FieldRole = "create" | "mutable" | "filterable" | "orderable";

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
   * - `"orderable"` — field can be used in `orderBy` / sort. When no field
   *   declares `"orderable"`, the `"filterable"` set is reused so existing
   *   configs keep sorting on their filterable fields (fail-closed: fields
   *   that are neither filterable nor orderable cannot be sorted on).
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
  /**
   * Per-operation authorization rules. Evaluated **after** the global `auth`
   * middleware has populated `req.user` and **before** the handler executes.
   *
   * **Default deny**: when the server has `auth` configured AND a rule for an
   * operation is omitted, that operation returns 403. Use `allowAll` from
   * `@lpdjs/firestore-repo-service/servers/auth` to explicitly open an
   * operation. When the server has no `auth`, rules are ignored.
   *
   * Each rule receives a context with the authenticated user and any
   * operation-specific payload, and returns a boolean (sync or async).
   *
   * - `list`/`get`: pre-fetch authorization. To filter rows post-fetch
   *   (row-level security on `list` results), use `filter`.
   * - `filter`: applied to every document returned by `list`/`query`/`get`.
   *   Returning `false` removes the row from the response (or yields 404 for
   *   single-doc `get`).
   *
   * @example
   * ```ts
   * rules: {
   *   list:   () => true,
   *   get:    ({ user, doc }) => doc.public || doc.authorId === user.uid,
   *   create: ({ user })      => !!user.uid,
   *   update: ({ user, doc }) => user.uid === doc.authorId,
   *   delete: ({ user, doc }) => user.claims.role === "moderator",
   *   filter: ({ user, doc }) => doc.public || doc.authorId === user.uid,
   * }
   * ```
   */
  rules?: CrudRules<TRepo>;
}

/** Context passed to {@link CrudRules.list}. */
export interface CrudListRuleContext {
  user: import("../auth").AuthUser;
  query: Record<string, unknown>;
  params: Record<string, string>;
}

/** Context passed to {@link CrudRules.get}. */
export interface CrudGetRuleContext<T = Record<string, unknown>> {
  user: import("../auth").AuthUser;
  doc: T;
  params: Record<string, string>;
}

/** Context passed to {@link CrudRules.create}. */
export interface CrudCreateRuleContext<T = Record<string, unknown>> {
  user: import("../auth").AuthUser;
  body: Partial<T>;
  params: Record<string, string>;
}

/** Context passed to {@link CrudRules.update}. */
export interface CrudUpdateRuleContext<T = Record<string, unknown>> {
  user: import("../auth").AuthUser;
  doc: T;
  body: Partial<T>;
  params: Record<string, string>;
}

/** Context passed to {@link CrudRules.delete}. */
export interface CrudDeleteRuleContext<T = Record<string, unknown>> {
  user: import("../auth").AuthUser;
  doc: T;
  params: Record<string, string>;
}

/** Context passed to {@link CrudRules.filter}. */
export interface CrudFilterRuleContext<T = Record<string, unknown>> {
  user: import("../auth").AuthUser;
  doc: T;
  params: Record<string, string>;
}

/**
 * Per-repo, per-operation authorization rules.
 * @template TRepo - The configured repository (used to type `doc` and `body`).
 */
export interface CrudRules<
  TRepo extends ConfiguredRepository<any> = ConfiguredRepository<any>,
> {
  list?: (ctx: CrudListRuleContext) => boolean | Promise<boolean>;
  get?: (
    ctx: CrudGetRuleContext<RepoModelType<TRepo>>,
  ) => boolean | Promise<boolean>;
  create?: (
    ctx: CrudCreateRuleContext<RepoModelType<TRepo>>,
  ) => boolean | Promise<boolean>;
  update?: (
    ctx: CrudUpdateRuleContext<RepoModelType<TRepo>>,
  ) => boolean | Promise<boolean>;
  delete?: (
    ctx: CrudDeleteRuleContext<RepoModelType<TRepo>>,
  ) => boolean | Promise<boolean>;
  /** Row-level filter applied to every doc returned by `list` / `query` / `get`. */
  filter?: (
    ctx: CrudFilterRuleContext<RepoModelType<TRepo>>,
  ) => boolean | Promise<boolean>;
}

/** Erased rules type stored on the runtime registry entry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCrudRules = CrudRules<any>;

/**
 * Internal repo entry for the CRUD server.
 */
export interface CrudRepoEntry {
  name: string;
  path: string;
  repo: ConfiguredRepository<
    RepositoryConfig<any, any, any, any, any, any, any, any, any, any, any>
  >;
  schema: z.ZodObject<any>;
  /** Keys automatically managed by Firestore (docId, path, timestamps) — excluded from create/update payloads */
  systemKeys: string[];
  documentKey: string;
  /** Field name that stores the full Firestore document path (e.g. "documentPath") */
  pathKey?: string;
  /** Whether this repo is a collection group (subcollection) */
  isGroup?: boolean;
  /** Parent key field names needed to build a subcollection document ref (auto-detected from refCb) */
  parentKeys?: string[];
  /** Field name for the creation timestamp (auto-set on create) */
  createdKey?: string;
  pageSize: number;
  /** Resolved from fieldsConfig: fields with role "filterable" */
  filterableFields?: string[];
  /** Resolved from fieldsConfig: fields with role "orderable" (falls back to filterableFields) */
  orderableFields?: string[];
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
  /** Per-operation authorization rules (see {@link CrudRules}). */
  rules?: AnyCrudRules;
}

export type CrudRepoRegistry = Record<string, CrudRepoEntry>;

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
> extends Omit<HonoServerOptions<any>, "routes" | "api" | "openapi"> {
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
   * Baseline security response headers (X-Frame-Options, nosniff,
   * Referrer-Policy, Cache-Control, optional CSP). Enabled by default; for
   * this JSON API the CSP is omitted unless you provide one (so the bundled
   * `/__docs` UI keeps working). Pass an options object to customise or
   * `false` to disable (issue #12).
   */
  securityHeaders?: import("../utils/security-headers").SecurityHeadersOptions | false;

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

  /**
   * Options forwarded to `onRequest()` from `firebase-functions/v2/https`.
   * Stored on the returned handler as `.httpsOptions` for easy access.
   *
   * @example
   * ```ts
   * const handler = createCrudServer({ httpsOptions: { invoker: "public" }, ... });
   * export const crud = onRequest(handler.httpsOptions!, handler);
   * ```
   */
  httpsOptions?: HttpsOptions;
}

// ---------------------------------------------------------------------------
// Response types

/**
 * Standard API response wrapper.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Discriminator for known error categories. Currently:
   * - "index" → Firestore composite index missing; see `indexUrl`.
   */
  errorType?: "index";
  /**
   * Firebase Console URL to create the missing composite index.
   * Always present when `errorType === "index"`. The CRUD server fills this in
   * even for collection-group queries, where the Firestore SDK does not
   * include the link in the error message.
   */
  indexUrl?: string;
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
