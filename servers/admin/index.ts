/**
 * @module servers/admin
 *
 * Creates a static ORM admin interface served as a Firebase HTTPS function.
 *
 * Features:
 *  - Dashboard listing all registered repositories
 *  - Document list with cursor-based pagination
 *  - Create / Edit / Delete forms generated from Zod schemas
 *  - Forms map **exactly** to the repository model type
 *  - Zero JavaScript framework — plain HTML + inline CSS + vanilla JS
 *  - Body parsing for `application/x-www-form-urlencoded` (default HTML forms)
 *    and `application/json` (API clients)
 *
 * @example
 * ```ts
 * import * as functions from "firebase-functions";
 * import { z } from "zod";
 * import { createAdminServer } from "@lpdjs/firestore-repo-service/servers/admin";
 *
 * const postSchema = z.object({
 *   title:    z.string().min(1),
 *   content:  z.string(),
 *   status:   z.enum(["draft", "published"]),
 *   authorId: z.string(),
 * });
 *
 * export const adminApp = functions.https.onRequest(
 *   createAdminServer({
 *     basePath: "/admin",
 *     repos: {
 *       posts: { repo: repos.posts, schema: postSchema, path: "posts" },
 *     },
 *   })
 * );
 * ```
 */

import type { z } from "zod";
import type { ConfiguredRepository } from "../../src/repositories/types";
import type { FieldPath, RepositoryConfig } from "../../src/shared/types";
import type { HttpRequest, HttpResponse } from "../http-types";
import type { AdminRepoEntry, RepoRegistry } from "./handlers";
import { createAdminHandlers } from "./handlers";
import type { RelationalFieldMeta } from "./renderer";
import { type Middleware, MiniRouter } from "./router";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Extracts the model type `T` from a `ConfiguredRepository`.
 * @internal
 */
type RepoModelType<TRepo> =
  TRepo extends ConfiguredRepository<
    RepositoryConfig<infer T, any, any, any, any, any, any, any, any, any>
  >
    ? T
    : never;

/**
 * Configuration for a single repository in the admin server.
 *
 * @template TRepo - The `ConfiguredRepository` type; used to derive typed field names.
 *
 * If the repository was created with `createRepositoryConfig(schema)(config)`,
 * the `schema` field is optional — it is auto-detected from the repo.
 * Otherwise, pass `schema` explicitly.
 *
 * @example
 * ```ts
 * posts: {
 *   repo: repos.posts,            // ConfiguredRepository inferred → PostModel
 *   filterableFields: ["status"],  // ✔ autocomplete + error if invalid key
 *   mutableFields: ["title"],
 *   createFields: ["title", "content"],
 *   allowDelete: true,
 * }
 * ```
 */
export interface AdminRepoConfig<
  TRepo extends ConfiguredRepository<any> = ConfiguredRepository<any>,
> {
  /** The configured repository instance. Drives type inference for all other fields. */
  repo: TRepo;
  /**
   * Zod schema — optional when the repo was created with `createRepositoryConfig(schema)`.
   * Pass explicitly for repos created with the legacy `createRepositoryConfig<T>()` form.
   */
  schema?: z.ZodObject<z.ZodRawShape>;
  /** Firestore collection path (for display only) */
  path: string;
  /** Key used to identify documents (default: "docId") */
  documentKey?: string;
  /** Columns to display in the list view (default: all schema keys) */
  listColumns?: string[];
  /** Number of documents per page in the list view (default: 25) */
  pageSize?: number;
  /**
   * Fields shown in the filter bar — typed to the model keys.
   * Defaults to all schema keys.
   */
  filterableFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Fields shown in the **edit** form — typed to the model keys.
   * Supports dot-notation for nested fields (e.g. `"address.city"`).
   * If unset, all schema fields are shown.
   */
  mutableFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Fields shown in the **create** form — typed to the model keys.
   * Supports dot-notation for nested fields (e.g. `"address.city"`).
   * If unset, all schema fields are shown.
   */
  createFields?: FieldPath<RepoModelType<TRepo>>[];
  /**
   * Whether to show the delete button in the list view.
   * Default: false — delete is disabled unless explicitly set to true.
   */
  allowDelete?: boolean;
  /**
   * Relational action columns appended to the list table.
   * Each entry adds a dedicated button that navigates to the linked repository.
   *
   * - **type "one"** (e.g. `userId` on a post) → button links to the target
   *   document edit page: `/{targetRepo}/{value}/edit`
   * - **type "many"** (e.g. `docId` on a user) → button links to the target
   *   repo list filtered by value: `/{targetRepo}?fv_{targetKey}={value}`
   *
   * @example
   * ```ts
   * users: {
   *   repo: repos.users,
   *   relationalFields: [
   *     { key: "docId", column: "Posts" },     // many → list of posts by this user
   *   ]
   * }
   * posts: {
   *   repo: repos.posts,
   *   relationalFields: [
   *     { key: "userId", column: "Author" },   // one → edit page of the user
   *   ]
   * }
   * ```
   */
  relationalFields?: {
    key: keyof RepoModelType<TRepo> & string;
    column: string;
  }[];
}

/**
 * HTTP Basic Auth configuration.
 * The browser will show a native login dialog.
 */
export interface BasicAuthConfig {
  type: "basic";
  /** Realm displayed in the browser login dialog */
  realm?: string;
  username: string;
  password: string;
}

/**
 * Options for `createAdminServer`.
 *
 * Made generic so TypeScript can infer the model type of each repo entry
 * and provide autocomplete + type-checking on `filterableFields`, `mutableFields`,
 * and `createFields`.
 *
 * @template TRepos - Shape of the repos map (inferred automatically at the call site)
 */
export interface AdminServerOptions<
  TRepos extends Record<string, ConfiguredRepository<any>> = Record<
    string,
    ConfiguredRepository<any>
  >,
> {
  /**
   * Base URL path of the function (e.g. "/admin").
   * Must match the path where the Firebase Function is mounted.
   * Default: "/"
   */
  basePath?: string;

  /**
   * Repository entries keyed by a display name.
   * TypeScript infers the model type from each `repo` field,
   * so `filterableFields`, `mutableFields`, and `createFields` are
   * typed to `keyof` that model.
   *
   * @example
   * ```ts
   * repos: {
   *   posts: {
   *     repo: repos.posts,
   *     filterableFields: ["status", "userId"],  // ✔ typed to PostModel keys
   *     mutableFields:    ["title", "content"],
   *     createFields:     ["title", "content", "status"],
   *   },
   * }
   * ```
   */
  repos: { [K in keyof TRepos]: AdminRepoConfig<TRepos[K]> };

  /** Whether to parse URL-encoded bodies. Default: true. */
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
}

// ---------------------------------------------------------------------------
// Body parser (replaces express.urlencoded in Firebase Functions context)
// ---------------------------------------------------------------------------

/** Eagerly reads the raw request body as a string */
async function readRawBody(req: HttpRequest): Promise<string> {
  if (typeof (req as any).rawBody === "string")
    return (req as any).rawBody as string;
  if (Buffer.isBuffer((req as any).rawBody))
    return ((req as any).rawBody as Buffer).toString("utf8");
  // Firebase Functions v2 / Cloud Run: body may already be parsed
  return "";
}

function parseUrlEncoded(body: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  if (!body) return result;
  for (const pair of body.split("&")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    const existing = result[key];
    if (existing === undefined) {
      result[key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      result[key] = [existing, val];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express-compatible request handler for the admin ORM UI.
 */
export function createAdminServer<
  TRepos extends Record<string, ConfiguredRepository<any>>,
>(
  options: AdminServerOptions<TRepos>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (req: any, res: any) => Promise<void> {
  const {
    basePath = "/",
    repos,
    parseBody = true,
    auth,
    middleware: extraMiddleware = [],
  } = options;

  // Normalise basePath: no trailing slash
  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");

  // Build the registry
  const registry: RepoRegistry = {};
  for (const [name, cfg] of Object.entries(repos)) {
    // Schema resolution: explicit cfg.schema > embedded in repo (createRepositoryConfig(schema))
    const resolvedSchema = cfg.schema ?? (cfg.repo as any).schema ?? null;
    if (!resolvedSchema) {
      throw new Error(
        `[createAdminServer] Repository "${name}" has no Zod schema. ` +
          `Either use createRepositoryConfig(schema)(config) or pass schema: explicitly.`,
      );
    }
    const entry: AdminRepoEntry = {
      name,
      path: cfg.path,
      repo: cfg.repo,
      schema: resolvedSchema,
      documentKey: cfg.documentKey ?? "docId",
      listColumns: cfg.listColumns,
      pageSize: cfg.pageSize,
      filterableFields: cfg.filterableFields as string[] | undefined,
      mutableFields: cfg.mutableFields as string[] | undefined,
      createFields: cfg.createFields as string[] | undefined,
      allowDelete: cfg.allowDelete ?? false,
      relationalMeta: (() => {
        if (!cfg.relationalFields || cfg.relationalFields.length === 0)
          return undefined;
        const repoRelKeys = (cfg.repo as any).relationalKeys ?? {};
        const meta: RelationalFieldMeta[] = [];
        for (const entry of cfg.relationalFields) {
          const rel = repoRelKeys[entry.key];
          if (rel) {
            meta.push({
              key: entry.key,
              column: entry.column,
              targetRepo: String(rel.repo),
              targetKey: String(rel.key),
              type: rel.type as "one" | "many",
            });
          }
        }
        return meta.length > 0 ? meta : undefined;
      })(),
    };
    registry[name] = entry;
  }

  const handlers = createAdminHandlers(registry, base);

  // ── Router ─────────────────────────────────────────────────────────────
  const router = new MiniRouter();

  // ── 1. Body-parsing middleware ──────────────────────────────────────────
  if (parseBody) {
    router.use(async (req, _res, next) => {
      const r = req as unknown as HttpRequest;
      const contentType = String(r.headers?.["content-type"] ?? "");
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const raw = await readRawBody(r);
        (req as any).body = parseUrlEncoded(raw);
      } else if (
        contentType.includes("application/json") &&
        typeof r.body === "string"
      ) {
        try {
          (req as any).body = JSON.parse(r.body as string);
        } catch {
          /* keep as string */
        }
      }
      await next();
    });
  }

  // ── 2. Auth middleware ──────────────────────────────────────────────────
  if (auth) {
    if (typeof auth === "function") {
      // Custom middleware
      router.use(auth);
    } else {
      // HTTP Basic Auth
      const realm = auth.realm ?? "Admin";
      const expected =
        "Basic " +
        Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      router.use((req, res, next) => {
        const authorization = (req as any).headers?.["authorization"] ?? "";
        if (authorization !== expected) {
          res
            .status(401)
            .set("WWW-Authenticate", `Basic realm="${realm}"`)
            .set("Content-Type", "text/plain")
            .send("Unauthorized");
          return;
        }
        next();
      });
    }
  }

  // ── 3. Extra user middleware ────────────────────────────────────────────
  for (const mw of extraMiddleware) {
    router.use(mw);
  }

  // ── 4. Routes ─────────────────────────────────────────────────────────────
  router.get(`${base}/`, handlers.handleDashboard);
  router.get(`${base}`, handlers.handleDashboard);

  router.get(`${base}/:repoName`, handlers.handleList);

  router.get(`${base}/:repoName/create`, handlers.handleCreateForm);
  router.post(`${base}/:repoName/create`, handlers.handleCreateSubmit as any);

  router.get(`${base}/:repoName/:id/edit`, handlers.handleEditForm as any);
  router.post(`${base}/:repoName/:id/edit`, handlers.handleEditSubmit as any);

  router.post(`${base}/:repoName/:id/delete`, handlers.handleDelete as any);

  // ── Request handler ─────────────────────────────────────────────────────
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    await router.handle(req as any, res as any);
  };
}

// Re-exports for convenience
export type { AdminRepoEntry, RepoRegistry } from "./handlers";
export { MiniRouter } from "./router";
export type { Middleware, RouteHandler } from "./router";
