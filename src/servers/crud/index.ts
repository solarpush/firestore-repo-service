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
 *         fieldsConfig: {
 *           status:   ["filterable"],
 *           authorId: ["filterable"],
 *         },
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

import { MiniRouter } from "../admin/router";
import type { HttpRequest, HttpResponse } from "../http-types";
import type { ConfiguredRepository } from "../../repositories/types";
import { createCrudHandlers } from "./handlers";
import { generateOpenAPISpec, type OpenAPIDocument } from "./openapi";
import type {
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Scalar API docs HTML template
// ---------------------------------------------------------------------------

/** Returns a self-contained HTML page using Scalar to render the spec. */
function scalarDocsHtml(title: string, specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

/**
 * Compute the URL prefix for links / spec URLs.
 * In the Firebase emulator the /{project}/{region}/{functionTarget} prefix
 * is visible in URLs but stripped before the handler receives `req.url`.
 * In production Firebase proxy strips it automatically.
 */
function getLinkBase(staticBasePath: string): string {
  const base = staticBasePath === "/" ? "" : staticBasePath.replace(/\/$/, "");

  if (process.env["FUNCTIONS_EMULATOR"] === "true") {
    const project =
      process.env["GCLOUD_PROJECT"] ??
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      "demo-project";
    const region = process.env["FUNCTION_REGION"] ?? "us-central1";
    const target = process.env["FUNCTION_TARGET"] ?? "";
    return `/${project}/${region}/${target}${base}`;
  }

  return base;
}

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
 *         fieldsConfig: {
 *           name:     ["create", "mutable"],
 *           email:    ["create", "mutable", "filterable"],
 *           isActive: ["filterable"],
 *         },
 *         allowDelete: false,
 *       },
 *       posts: {
 *         repo: repos.posts,
 *         path: "posts",
 *         fieldsConfig: {
 *           status: ["filterable"],
 *           userId: ["filterable"],
 *         },
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
>(
  options: CrudServerOptions<TRepos>,
): (req: any, res: any) => Promise<void> {
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

    // Resolve fieldsConfig → separate arrays for runtime
    let filterableFields: string[] | undefined;
    let mutableFields: string[] | undefined;
    let createFields: string[] | undefined;
    if (cfg.fieldsConfig) {
      const fc = cfg.fieldsConfig as Record<string, readonly string[]>;
      filterableFields = [];
      mutableFields = [];
      createFields = [];
      for (const [field, roles] of Object.entries(fc)) {
        for (const role of roles) {
          if (role === "filterable") filterableFields.push(field);
          else if (role === "mutable") mutableFields.push(field);
          else if (role === "create") createFields.push(field);
        }
      }
      if (filterableFields.length === 0) filterableFields = undefined;
      if (mutableFields.length === 0) mutableFields = undefined;
      if (createFields.length === 0) createFields = undefined;
    }

    const entry: CrudRepoEntry = {
      name,
      path: cfg.path,
      repo: cfg.repo,
      schema: resolvedSchema,
      systemKeys: (cfg.repo as any)._systemKeys ?? [cfg.documentKey ?? "docId"],
      documentKey: cfg.documentKey ?? "docId",
      pathKey: (cfg.repo as any)._pathKey ?? undefined,
      pageSize: cfg.pageSize ?? 25,
      filterableFields,
      mutableFields,
      createFields,
      allowDelete: cfg.allowDelete ?? false,
      allowedIncludes: cfg.allowedIncludes as string[] | undefined,
      validate: cfg.validate as CrudRepoEntry["validate"],
    };

    registry[name] = entry;
  }

  const handlers = createCrudHandlers(registry, base, verbose);

  // ── OpenAPI spec (cached) ─────────────────────────────────────────────
  const openapi = options.openapi;
  const openapiOpts = openapi && typeof openapi === "object" ? openapi : {};
  let _specCache: OpenAPIDocument | null = null;
  function getSpec(): OpenAPIDocument {
    if (!_specCache) {
      const authType =
        auth && typeof auth !== "function"
          ? ("basic" as const)
          : auth
            ? ("bearer" as const)
            : false;
      _specCache = generateOpenAPISpec(registry, base, {
        ...openapiOpts,
        auth: openapiOpts.auth ?? authType,
      });
    }
    return _specCache;
  }

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

  // ── OpenAPI spec & docs endpoints (before auth so they're public) ────
  if (openapi !== false) {
    const specPath = `${base}/__spec.json`;
    const docsPath = `${base}/__docs`;

    router.get(specPath, (_req: any, res: any) => {
      const spec = getSpec();
      res
        .status(200)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(JSON.stringify(spec, null, 2));
    });

    router.get(docsPath, (_req: any, res: any) => {
      // Rebuild spec URL with the Firebase Functions prefix when running
      // in the emulator so Scalar can fetch the spec correctly.
      const specUrl = getLinkBase(base) + "/__spec.json";
      const html = scalarDocsHtml(openapiOpts.title ?? "CRUD API", specUrl);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .send(html);
    });
  }

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
  const handler = async (
    req: HttpRequest,
    res: HttpResponse,
  ): Promise<void> => {
    await router.handle(req as any, res as any);
  };

  // Attach spec getter so users can call server.spec() programmatically
  (handler as any).spec = getSpec;

  return handler as ((req: any, res: any) => Promise<void>) & {
    /** Return the generated OpenAPI 3.1 document. */
    spec: () => OpenAPIDocument;
  };
}

// Re-exports for convenience
export { generateOpenAPISpec } from "./openapi";
export type { OpenAPIDocument, OpenAPISpecOptions } from "./openapi";
export type {
  ApiResponse,
  BasicAuthConfig,
  CrudRepoConfig,
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
  FieldRole,
  ListResponseData,
  Middleware,
  QueryRequestBody,
  RepoFieldPath,
  RepoRelationKeys,
  UserFieldPath,
} from "./types";
