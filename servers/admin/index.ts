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
import type { RepositoryConfig } from "../../src/shared/types";
import type { HttpRequest, HttpResponse } from "../http-types";
import type { AdminRepoEntry, RepoRegistry } from "./handlers";
import { createAdminHandlers } from "./handlers";
import { type Middleware, MiniRouter } from "./router";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Configuration for a single repository in the admin server.
 * @template TConfig - Repository configuration
 */
export interface AdminRepoConfig<
  TConfig extends RepositoryConfig<
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
  > = RepositoryConfig<any, any, any, any, any, any, any, any, any, any>,
> {
  /** The configured repository instance */
  repo: ConfiguredRepository<TConfig>;
  /**
   * Zod schema that **exactly** maps to the repository's model type.
   * Used to generate forms and validate submissions.
   */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Firestore collection path (for display only) */
  path: string;
  /** Key used to identify documents (default: "docId") */
  documentKey?: string;
  /** Columns to display in the list view (default: all schema keys) */
  listColumns?: string[];
  /** Number of documents per page in the list view (default: 25) */
  pageSize?: number;
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
 * Options for `createAdminServer`
 */
export interface AdminServerOptions {
  /**
   * Base URL path of the function (e.g. "/admin").
   * Must match the path where the Firebase Function is mounted.
   * Default: "/"
   */
  basePath?: string;

  /**
   * Repository entries keyed by a display name.
   *
   * @example
   * repos: {
   *   posts: { repo: repos.posts, schema: postSchema, path: "posts" },
   *   users: { repo: repos.users, schema: userSchema, path: "users" },
   * }
   */
  repos: Record<string, AdminRepoConfig>;

  /**
   * Whether to parse URL-encoded bodies. Default: true.
   * Set to false if you handle body parsing elsewhere.
   */
  parseBody?: boolean;

  /**
   * Authentication guard executed before every request.
   * - Pass a `BasicAuthConfig` to enable HTTP Basic Auth (browser login dialog).
   * - Pass a `Middleware` function for custom auth logic (JWT, session, etc.).
   *
   * @example — Basic Auth
   * auth: { type: "basic", username: "admin", password: "secret" }
   *
   * @example — Custom middleware
   * auth: (req, res, next) => {
   *   if (req.headers?.["x-admin-token"] !== "mytoken") {
   *     res.status(401).set("Content-Type", "text/plain").send("Unauthorized");
   *     return;
   *   }
   *   next();
   * }
   */
  auth?: BasicAuthConfig | Middleware;

  /**
   * Additional middleware functions executed after auth, before route handlers.
   * Useful for logging, rate-limiting, injecting context, etc.
   *
   * @example
   * middleware: [
   *   (req, _res, next) => { console.log(req.method, req.url); next(); },
   * ]
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
export function createAdminServer(
  options: AdminServerOptions,
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
    const entry: AdminRepoEntry = {
      name,
      path: cfg.path,
      repo: cfg.repo,
      schema: cfg.schema,
      documentKey: cfg.documentKey ?? "docId",
      listColumns: cfg.listColumns,
      pageSize: cfg.pageSize,
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
