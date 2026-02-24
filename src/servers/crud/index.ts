/**
 * @module servers/crud
 *
 * Creates a REST API server for CRUD operations on Firestore repositories.
 *
 * Features:
 *  - RESTful endpoints for List, Get, Create, Update, Delete
 *  - Request validation using Zod schemas
 *  - Cursor-based pagination
 *  - Query filtering with operators (eq, ne, lt, gt, in, etc.)
 *  - Field selection
 *  - CORS support
 *  - Configurable auth (Basic Auth or custom middleware)
 *
 * @example
 * ```ts
 * import * as functions from "firebase-functions";
 * import { z } from "zod";
 * import { createCrudServer } from "@lpdjs/firestore-repo-service/servers/crud";
 *
 * const postSchema = z.object({
 *   title:    z.string().min(1),
 *   content:  z.string(),
 *   status:   z.enum(["draft", "published"]),
 *   authorId: z.string(),
 * });
 *
 * export const api = functions.https.onRequest(
 *   createCrudServer({
 *     basePath: "/api",
 *     repos: {
 *       posts: {
 *         repo: repos.posts,
 *         schema: postSchema,
 *         path: "posts",
 *         filterableFields: ["status", "authorId"],
 *         allowDelete: true,
 *       },
 *     },
 *   })
 * );
 * ```
 *
 * ## API Endpoints
 *
 * | Method | Path              | Description              |
 * |--------|-------------------|--------------------------|
 * | GET    | /:repo            | List documents (paginated) |
 * | GET    | /:repo/:id        | Get single document      |
 * | POST   | /:repo            | Create document          |
 * | PUT    | /:repo/:id        | Update document (full)   |
 * | PATCH  | /:repo/:id        | Update document (partial)|
 * | DELETE | /:repo/:id        | Delete document          |
 *
 * ## Query Parameters (GET list)
 *
 * | Param      | Description                              |
 * |------------|------------------------------------------|
 * | pageSize   | Number of items per page (max 100)       |
 * | cursor     | Base64 pagination cursor                 |
 * | orderBy    | Field to order by                        |
 * | orderDir   | Order direction (asc/desc)               |
 * | select     | Comma-separated fields to return         |
 * | field      | Filter by field (field=value)            |
 * | field__op  | Filter with operator (field__gt=10)      |
 *
 * ## Filter Operators
 *
 * | Suffix      | Firestore Op      | Example               |
 * |-------------|-------------------|-----------------------|
 * | (none)      | ==                | status=active         |
 * | __eq        | ==                | status__eq=active     |
 * | __ne        | !=                | status__ne=draft      |
 * | __lt        | <                 | age__lt=18            |
 * | __lte       | <=                | age__lte=18           |
 * | __gt        | >                 | age__gt=18            |
 * | __gte       | >=                | age__gte=18           |
 * | __in        | in                | status__in=a,b,c      |
 * | __nin       | not-in            | status__nin=x,y       |
 * | __contains  | array-contains    | tags__contains=news   |
 */

import type { ConfiguredRepository } from "../../repositories/types";
import { MiniRouter } from "../admin/router";
import type { HttpRequest, HttpResponse } from "../http-types";
import { createCrudHandlers } from "./handlers";
import type {
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

/** Eagerly reads the raw request body as a string */
async function readRawBody(req: HttpRequest): Promise<string> {
  if (typeof (req as any).rawBody === "string")
    return (req as any).rawBody as string;
  if (Buffer.isBuffer((req as any).rawBody))
    return ((req as any).rawBody as Buffer).toString("utf8");
  return "";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express-compatible request handler for a REST CRUD API.
 *
 * @template TRepos - Shape of the repos map (inferred automatically)
 * @param options - CRUD server configuration
 * @returns Express-compatible request handler for Firebase Functions
 *
 * @example
 * ```typescript
 * // Basic CRUD server
 * import { onRequest } from "firebase-functions/https";
 * import { createCrudServer } from "@lpdjs/firestore-repo-service/servers/crud";
 *
 * export const api = onRequest(
 *   createCrudServer({
 *     basePath: "/api",
 *     repos: {
 *       users: {
 *         repo: repos.users,
 *         path: "users",
 *         filterableFields: ["email", "isActive"],
 *         mutableFields: ["name", "email"],
 *         createFields: ["name", "email"],
 *         allowDelete: false,
 *       },
 *       posts: {
 *         repo: repos.posts,
 *         path: "posts",
 *         filterableFields: ["status", "userId"],
 *         allowDelete: true,
 *       },
 *     },
 *   })
 * );
 *
 * // With authentication
 * export const api = onRequest(
 *   createCrudServer({
 *     basePath: "/api",
 *     auth: {
 *       type: "basic",
 *       username: "api",
 *       password: process.env.API_PASSWORD!,
 *     },
 *     repos: { ... },
 *   })
 * );
 *
 * // With custom auth middleware
 * export const api = onRequest(
 *   createCrudServer({
 *     auth: async (req, res, next) => {
 *       const token = req.headers?.authorization?.replace("Bearer ", "");
 *       if (!token || !(await verifyToken(token))) {
 *         res.status(401).json({ success: false, error: "Unauthorized" });
 *         return;
 *       }
 *       next();
 *     },
 *     repos: { ... },
 *   })
 * );
 *
 * // With custom validation
 * export const api = onRequest(
 *   createCrudServer({
 *     repos: {
 *       posts: {
 *         repo: repos.posts,
 *         path: "posts",
 *         validate: async (data, operation) => {
 *           if (operation === "create" && !data.title) {
 *             return "Title is required";
 *           }
 *           return undefined;
 *         },
 *       },
 *     },
 *   })
 * );
 * ```
 */
export function createCrudServer<
  TRepos extends Record<string, ConfiguredRepository<any>>,
>(options: CrudServerOptions<TRepos>): (req: any, res: any) => Promise<void> {
  const {
    basePath = "/",
    repos,
    parseBody = true,
    auth,
    middleware: extraMiddleware = [],
    verbose = false,
  } = options;

  // Normalise basePath: no trailing slash
  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");

  // Build the registry
  const registry: CrudRepoRegistry = {};
  for (const [name, cfg] of Object.entries(repos)) {
    // Schema resolution: explicit cfg.schema > embedded in repo (createRepositoryConfig(schema))
    const resolvedSchema = cfg.schema ?? (cfg.repo as any).schema ?? null;
    if (!resolvedSchema) {
      throw new Error(
        `[createCrudServer] Repository "${name}" has no Zod schema. ` +
          `Either use createRepositoryConfig(schema)(config) or pass schema: explicitly.`,
      );
    }

    const entry: CrudRepoEntry = {
      name,
      path: cfg.path,
      repo: cfg.repo,
      schema: resolvedSchema,
      documentKey: cfg.documentKey ?? "docId",
      pageSize: cfg.pageSize ?? 25,
      filterableFields: cfg.filterableFields as string[] | undefined,
      mutableFields: cfg.mutableFields as string[] | undefined,
      createFields: cfg.createFields as string[] | undefined,
      allowDelete: cfg.allowDelete ?? false,
      allowedIncludes: cfg.allowedIncludes,
      validate: cfg.validate as CrudRepoEntry["validate"],
    };
    registry[name] = entry;
  }

  const handlers = createCrudHandlers(registry, base, verbose);

  // ── Router ─────────────────────────────────────────────────────────────
  const router = new MiniRouter();

  // ── CORS middleware ─────────────────────────────────────────────────────
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Credentials", "true");
    next();
  });

  // ── 1. Body-parsing middleware ──────────────────────────────────────────
  if (parseBody) {
    router.use(async (req, _res, next) => {
      const r = req as unknown as HttpRequest;
      const contentType = String(r.headers?.["content-type"] ?? "");
      if (contentType.includes("application/json")) {
        if (typeof r.body === "string") {
          try {
            (req as any).body = JSON.parse(r.body);
          } catch {
            /* keep as string */
          }
        } else if (Buffer.isBuffer((req as any).rawBody)) {
          try {
            const raw = await readRawBody(r);
            (req as any).body = JSON.parse(raw);
          } catch {
            /* keep as is */
          }
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
      const realm = auth.realm ?? "API";
      const expected =
        "Basic " +
        Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      router.use((req, res, next) => {
        const authorization = (req as any).headers?.["authorization"] ?? "";
        if (authorization !== expected) {
          res
            .status(401)
            .set("WWW-Authenticate", `Basic realm="${realm}"`)
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ success: false, error: "Unauthorized" }));
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

  // OPTIONS for CORS preflight
  router.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      handlers.handleOptions(req, res);
      return;
    }
    next();
  });

  // List: GET /:repoName
  router.get(`${base}/:repoName`, handlers.handleList);

  // Query: POST /:repoName/query (advanced filtering with body)
  router.post(`${base}/:repoName/query`, handlers.handleQuery);

  // Get: GET /:repoName/:id
  router.get(`${base}/:repoName/:id`, handlers.handleGet);

  // Create: POST /:repoName
  router.post(`${base}/:repoName`, handlers.handleCreate);

  // Update (full): PUT /:repoName/:id
  router.put(`${base}/:repoName/:id`, (req: any, res: any) =>
    handlers.handleUpdate(req, res, false),
  );

  // Update (partial): PATCH /:repoName/:id
  router.patch(`${base}/:repoName/:id`, (req: any, res: any) =>
    handlers.handleUpdate(req, res, true),
  );

  // Delete: DELETE /:repoName/:id
  router.delete(`${base}/:repoName/:id`, handlers.handleDelete);

  // ── Request handler ─────────────────────────────────────────────────────
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    await router.handle(req as any, res as any);
  };
}

// Re-exports for convenience
export type {
  ApiResponse,
  BasicAuthConfig,
  CrudRepoConfig,
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
  ListResponseData,
  Middleware,
  QueryRequestBody,
} from "./types";
