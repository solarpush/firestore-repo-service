/**
 * @module servers/crud
 *
 * Creates a REST API server for CRUD operations on Firestore repositories using HonoServer.
 */
import type { HttpsOptions } from "firebase-functions/v2/https";
import type { ConfiguredRepository } from "../../repositories/types";
import { createCrudHandlers } from "./handlers";
import { generateOpenAPISpec, type OpenAPIDocument } from "./openapi";
import type { CrudRepoEntry, CrudRepoRegistry, CrudServerOptions } from "./types";
import { HonoServer } from "../hono/server";
import type { AnyRouteDef } from "../hono/types";
import { getLinkBase } from "../utils/link-base";


export function createCrudServer<
  TRepos extends Record<string, ConfiguredRepository<any>>,
>(
  options: CrudServerOptions<TRepos>,
): ((req: any, res: any) => Promise<void>) & { spec: () => OpenAPIDocument; httpsOptions?: HttpsOptions } {
  const {
    basePath = "/",
    repos,
    parseBody = true,
    securityHeaders: securityHeadersOpt,
    verbose = false,
    httpsOptions,
  } = options;

  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");

  const registry: CrudRepoRegistry = {};
  for (const [name, cfg] of Object.entries(repos)) {
    if (!cfg.repo) {
      throw new Error(`[createCrudServer] Repository "${name}" has no 'repo' defined. Did you forget to pass it or is there a circular import?`);
    }

    const resolvedSchema = cfg.schema ?? (cfg.repo as any).schema ?? null;
    if (!resolvedSchema) {
      throw new Error(`[createCrudServer] Repository "${name}" has no Zod schema.`);
    }

    let filterableFields: string[] | undefined;
    let orderableFields: string[] | undefined;
    let mutableFields: string[] | undefined;
    let createFields: string[] | undefined;
    if (cfg.fieldsConfig) {
      const fc = cfg.fieldsConfig as Record<string, readonly string[]>;
      filterableFields = [];
      orderableFields = [];
      mutableFields = [];
      createFields = [];
      for (const [field, roles] of Object.entries(fc)) {
        for (const role of roles) {
          if (role === "filterable") filterableFields.push(field);
          else if (role === "orderable") orderableFields.push(field);
          else if (role === "mutable") mutableFields.push(field);
          else if (role === "create") createFields.push(field);
        }
      }
      if (orderableFields.length === 0) orderableFields = filterableFields;
      if (filterableFields.length === 0) filterableFields = undefined;
      if (orderableFields && orderableFields.length === 0) orderableFields = undefined;
      if (mutableFields.length === 0) mutableFields = undefined;
      if (createFields.length === 0) createFields = undefined;
    }

    const parentKeys = (() => {
      const pk = (cfg.repo as any)._parentKeys as string[] | undefined;
      return pk && pk.length > 0 ? pk : undefined;
    })();
    if (parentKeys && createFields) {
      for (const pk of parentKeys) {
        if (!createFields.includes(pk)) createFields.push(pk);
      }
    }

    const entry: CrudRepoEntry = {
      name,
      path: cfg.path,
      repo: cfg.repo,
      schema: resolvedSchema,
      systemKeys: (cfg.repo as any)._systemKeys ?? [cfg.documentKey ?? "docId"],
      documentKey: cfg.documentKey ?? "docId",
      pathKey: (cfg.repo as any)._pathKey ?? undefined,
      isGroup: !!(cfg.repo as any)._isGroup,
      parentKeys,
      createdKey: (cfg.repo as any)._createdKey ?? undefined,
      pageSize: cfg.pageSize ?? 25,
      filterableFields,
      orderableFields,
      mutableFields,
      createFields,
      allowDelete: cfg.allowDelete ?? false,
      allowedIncludes: cfg.allowedIncludes as string[] | undefined,
      validate: cfg.validate as CrudRepoEntry["validate"],
      rules: cfg.rules,
    };

    registry[name] = entry;
  }

  const handlers = createCrudHandlers(registry, base, verbose);

  const openapi = options.openapi;
  const openapiOpts = openapi && typeof openapi === "object" ? openapi : {};
  let _specCache: OpenAPIDocument | null = null;
  function getSpec(): OpenAPIDocument {
    if (!_specCache) {
      _specCache = generateOpenAPISpec(registry, base, {
        ...openapiOpts,
        auth: openapiOpts.auth ?? false,
      });
    }
    return _specCache;
  }

  const routes: AnyRouteDef[] = [];

  for (const name of Object.keys(registry)) {
    routes.push({
      api: "crud",
      method: "get",
      path: `/${name}`,
      source: "query",
      handler: handlers.handleList,
    });
    routes.push({
      api: "crud",
      method: "post",
      path: `/${name}/query`,
      source: "json",
      handler: handlers.handleQuery,
    });
    routes.push({
      api: "crud",
      method: "get",
      path: `/${name}/:id`,
      source: "query",
      handler: handlers.handleGet,
    });
    routes.push({
      api: "crud",
      method: "post",
      path: `/${name}`,
      source: "json",
      handler: handlers.handleCreate,
    });
    routes.push({
      api: "crud",
      method: "put",
      path: `/${name}/:id`,
      source: "json",
      handler: (ctx) => handlers.handleUpdate(ctx, false),
    });
    routes.push({
      api: "crud",
      method: "patch",
      path: `/${name}/:id`,
      source: "json",
      handler: (ctx) => handlers.handleUpdate(ctx, true),
    });
    routes.push({
      api: "crud",
      method: "delete",
      path: `/${name}/:id`,
      source: "query",
      handler: handlers.handleDelete,
    });
    routes.push({
      api: "crud",
      method: "post",
      path: `/${name}/batch`,
      source: "json",
      handler: handlers.handleBatch,
    });
  }

  // Create the HonoServer
  const server = new HonoServer({
    ...options,
    openapi: openapi !== false ? {
      path: openapiOpts.path ?? "/openapi.json",
      docsPath: openapiOpts.docsPath ?? "/docs",
      info: { 
        title: openapiOpts.title ?? "CRUD API", 
        version: openapiOpts.version ?? "1.0.0" 
      },
      docsAuth: openapiOpts.docsAuth as any,
    } : undefined,
    basePath,
    api: "crud",
    routes,
    middlewares: [
      async (c, next) => {
        if (c.req.method === "OPTIONS") {
          return c.text("", 204 as any, {
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true",
          });
        }
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Credentials", "true");
        await next();
        return;
      },
      ...(options.middlewares || []),
    ],
  });

  if (openapi !== false) {
    server.buildOpenApiSpec = getSpec as any;
  }

  if (securityHeadersOpt !== false) {
    const { securityHeaders } = require("../utils/security-headers");
    const base0 = securityHeadersOpt === undefined ? { csp: false as const } : securityHeadersOpt;
    server.hono.use("*", async (c, next) => {
      const adapter = securityHeaders(base0);
      await new Promise<void>((resolve) => {
        const fakeReq = c.req.raw;
        const fakeRes = {
          setHeader: (k: string, v: string) => c.header(k, v),
          removeHeader: (k: string) => c.res.headers.delete(k),
        };
        adapter(fakeReq, fakeRes, () => resolve());
      });
      await next();
    });
  }

  const handler = server.nodeHandler as any;
  handler.spec = getSpec;
  if (httpsOptions) handler.httpsOptions = httpsOptions;

  return handler;
}

export { generateOpenAPISpec } from "./openapi";
export type { OpenAPIDocument, OpenAPISpecOptions } from "./openapi";
export type {
  ApiResponse,
  CrudRepoConfig,
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
  FieldRole,
  ListResponseData,
  QueryRequestBody,
  RepoFieldPath,
  RepoRelationKeys,
  UserFieldPath,
} from "./types";
