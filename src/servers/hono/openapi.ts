/**
 * OpenAPI 3.1 spec generator from {@link RouteDef} entries.
 *
 * Uses `@asteasolutions/zod-to-openapi` directly so users keep importing the
 * vanilla `zod` package (no opinionated `z` re-export required).
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
  getOpenApiMetadata,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type {
  AnyRouteDef,
  HttpMethod,
  InterceptorConfig,
  InterceptorErrorResponse,
  OpenAPIConfig,
  PayloadSource,
} from "./types";

// Patches Zod prototype with `.openapi()` and enables schema → OpenAPI
// conversion for vanilla zod schemas. Idempotent — safe to call multiple times.
extendZodWithOpenApi(z);

const DEFAULT_RESPONSE_DESCRIPTION = "Successful response";
const DEFAULT_ERROR_DESCRIPTION = "Error response";

/**
 * Recursively walks a Zod schema graph and ensures any `z.custom()` / `z.instanceof()`
 * node (`def.type === "custom"`) has a `type` entry in its metadata.
 * Without this, `@asteasolutions/zod-to-openapi` throws `UnknownZodTypeError` when a
 * custom schema (e.g. Firestore `Timestamp` or `GeoPoint`) either lacks `.openapi(...)`
 * or only specifies `{ anyOf: [...] }` / `{ oneOf: [...] }` without a top-level `type`.
 */
function ensureCustomSchemasHaveOpenApiType(
  schema: unknown,
  visited = new Set<unknown>(),
): void {
  if (!schema || typeof schema !== "object" || visited.has(schema)) return;
  visited.add(schema);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  const def = s._zod?.def ?? s.def;
  if (!def) return;

  if (def.type === "custom") {
    const meta = getOpenApiMetadata(s) as Record<string, unknown> | undefined;
    if (!meta?.type) {
      z.globalRegistry.add(s, { ...(meta ?? {}), type: "object" });
    }
    return;
  }

  if (def.innerType) ensureCustomSchemasHaveOpenApiType(def.innerType, visited);
  if (def.element) ensureCustomSchemasHaveOpenApiType(def.element, visited);
  if (def.valueType) ensureCustomSchemasHaveOpenApiType(def.valueType, visited);
  if (def.keyType) ensureCustomSchemasHaveOpenApiType(def.keyType, visited);
  if (def.left) ensureCustomSchemasHaveOpenApiType(def.left, visited);
  if (def.right) ensureCustomSchemasHaveOpenApiType(def.right, visited);
  if (def.in) ensureCustomSchemasHaveOpenApiType(def.in, visited);
  if (def.out) ensureCustomSchemasHaveOpenApiType(def.out, visited);
  if (typeof def.getter === "function") {
    try {
      ensureCustomSchemasHaveOpenApiType(def.getter(), visited);
    } catch {
      // ignore lazy evaluation errors
    }
  }
  if (Array.isArray(def.options)) {
    for (const opt of def.options) ensureCustomSchemasHaveOpenApiType(opt, visited);
  }
  if (Array.isArray(def.items)) {
    for (const item of def.items) ensureCustomSchemasHaveOpenApiType(item, visited);
  }
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (shape && typeof shape === "object") {
    for (const val of Object.values(shape)) {
      ensureCustomSchemasHaveOpenApiType(val, visited);
    }
  }
}

/**
 * Recursively strips top-level `type` on schema nodes that also define `anyOf` or `oneOf`
 * (preventing OpenAPI 3.1 generator conflicts when a fallback `type: "object"` was injected).
 */
function stripRedundantTypeWithComposition(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) stripRedundantTypeWithComposition(item);
    return;
  }
  const record = node as Record<string, unknown>;
  if ((Array.isArray(record.anyOf) || Array.isArray(record.oneOf)) && "type" in record) {
    delete record.type;
  }
  for (const val of Object.values(record)) {
    stripRedundantTypeWithComposition(val);
  }
}

function defaultSource(method: HttpMethod): PayloadSource {
  return method === "get" ? "query" : "json";
}

/**
 * Resolve the success-envelope schema for a route, honouring an interceptor's
 * static schema or per-route factory. Falls back to the raw `route.output`.
 */
function resolveSuccessSchema(
  routeOutput: z.ZodTypeAny | undefined,
  interceptor: InterceptorConfig | undefined,
): z.ZodTypeAny | undefined {
  const out = interceptor?.output;
  if (!out) return routeOutput;
  return typeof out === "function" ? out(routeOutput) : out;
}

/** Normalise a declared error response to `{ description, schema? }`. */
function normalizeErrorResponse(
  entry: InterceptorErrorResponse,
): { description: string; schema?: z.ZodTypeAny } {
  // A Zod schema exposes `safeParse`; a plain config object does not.
  if (typeof (entry as { safeParse?: unknown }).safeParse === "function") {
    return { description: DEFAULT_ERROR_DESCRIPTION, schema: entry as z.ZodTypeAny };
  }
  const cfg = entry as { description?: string; schema?: z.ZodTypeAny };
  return { description: cfg.description ?? DEFAULT_ERROR_DESCRIPTION, schema: cfg.schema };
}

/** Build the OpenAPI document from the mounted route registry. */
export function buildOpenApiDocument(
  routes: AnyRouteDef[],
  basePath: string,
  config: OpenAPIConfig,
  interceptor?: InterceptorConfig,
): Record<string, unknown> {
  const registry = new OpenAPIRegistry();

  if (config.securitySchemes) {
    for (const [name, scheme] of Object.entries(config.securitySchemes)) {
      // The registry's runtime accepts any spec-shaped object; cast through
      // `unknown` to satisfy zod-to-openapi's stricter typings.
      registry.registerComponent(
        "securitySchemes",
        name,
        scheme as unknown as Parameters<
          typeof registry.registerComponent
        >[2],
      );
    }
  }

  for (const route of routes) {
    const method = route.method;
    const source = route.source ?? defaultSource(method);
    const fullPath = joinPath(basePath, route.path ?? "/");
    const status = route.status ?? 200;

    if (route.input) ensureCustomSchemasHaveOpenApiType(route.input);

    const requestBody = buildRequestBody(method, source, route.input);
    const requestQuery = buildQueryOrParam(source, route.input, "query");
    const requestParams = buildQueryOrParam(source, route.input, "param");
    const operationId = makeOperationId(method, fullPath);

    // Success response — wrapped by the interceptor envelope when declared.
    const successSchema = resolveSuccessSchema(route.output, interceptor);
    if (successSchema) ensureCustomSchemasHaveOpenApiType(successSchema);
    const responses: Record<string, unknown> = {
      [status]: successSchema
        ? {
            description: DEFAULT_RESPONSE_DESCRIPTION,
            content: { "application/json": { schema: successSchema } },
          }
        : { description: DEFAULT_RESPONSE_DESCRIPTION },
    };

    // Declared error responses (interceptor.errors) applied to every operation.
    if (interceptor?.errors) {
      for (const [code, entry] of Object.entries(interceptor.errors)) {
        const { description, schema } = normalizeErrorResponse(entry);
        if (schema) ensureCustomSchemasHaveOpenApiType(schema);
        responses[code] = schema
          ? { description, content: { "application/json": { schema } } }
          : { description };
      }
    }

    registry.registerPath({
      method,
      path: convertExpressPathToOpenApi(fullPath),
      operationId,
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      deprecated: route.deprecated,
      security: route.security,
      // Cast: registerPath types narrow query/params to ZodObject — we accept
      // any ZodTypeAny at runtime and let users pass plain objects via z.object.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request: {
        ...(requestQuery ? { query: requestQuery } : {}),
        ...(requestParams ? { params: requestParams } : {}),
        ...(requestBody ? { body: requestBody } : {}),
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responses: responses as any,
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    // OpenAPIInfo is structurally compatible; cast to satisfy the `x-*` index.
    info: config.info as Parameters<
      typeof generator.generateDocument
    >[0]["info"],
    servers: config.servers,
    security: config.security,
  });
  stripRedundantTypeWithComposition(document);
  return document as unknown as Record<string, unknown>;
}

function buildRequestBody(
  method: HttpMethod,
  source: PayloadSource,
  schema: z.ZodTypeAny | undefined,
): { content: Record<string, { schema: z.ZodTypeAny }> } | null {
  if (!schema) return null;
  if (method === "get") return null;
  if (source === "json") {
    return { content: { "application/json": { schema } } };
  }
  if (source === "form") {
    return {
      content: { "application/x-www-form-urlencoded": { schema } },
    };
  }
  return null;
}

function buildQueryOrParam(
  source: PayloadSource,
  schema: z.ZodTypeAny | undefined,
  target: "query" | "param",
): z.ZodTypeAny | undefined {
  if (!schema) return undefined;
  if (target === "query" && source === "query") return schema;
  if (target === "param" && source === "param") return schema;
  return undefined;
}

/** Convert `:foo` style express params to `{foo}` OpenAPI placeholders. */
function convertExpressPathToOpenApi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function joinPath(base: string, path: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = path.startsWith("/") ? path : `/${path}`;
  const merged = `${left}${right}`;
  return merged === "" ? "/" : merged;
}

function makeOperationId(method: HttpMethod, path: string): string {
  const cleaned = path
    .replace(/[{}]/g, "")
    .replace(/\/+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "");
  return `${method}_${cleaned || "root"}`;
}

/**
 * Render a self-contained Scalar API Reference HTML page that points to the
 * generated spec. Loaded from CDN — no build step required.
 */
export function renderDocsHtml(specUrl: string, title: string): string {
  const safeUrl = specUrl.replace(/"/g, "&quot;");
  const safeTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${safeTitle}</title>
</head>
<body>
<script id="api-reference" data-url="${safeUrl}"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
