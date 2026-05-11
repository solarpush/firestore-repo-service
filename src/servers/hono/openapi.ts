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
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type {
  AnyRouteDef,
  HttpMethod,
  OpenAPIConfig,
  PayloadSource,
} from "./types";

// Patches Zod prototype with `.openapi()` and enables schema → OpenAPI
// conversion for vanilla zod schemas. Idempotent — safe to call multiple times.
extendZodWithOpenApi(z);

const DEFAULT_RESPONSE_DESCRIPTION = "Successful response";

function defaultSource(method: HttpMethod): PayloadSource {
  return method === "get" ? "query" : "json";
}

/** Build the OpenAPI document from the mounted route registry. */
export function buildOpenApiDocument(
  routes: AnyRouteDef[],
  basePath: string,
  config: OpenAPIConfig,
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

    const requestBody = buildRequestBody(method, source, route.input);
    const requestQuery = buildQueryOrParam(source, route.input, "query");
    const requestParams = buildQueryOrParam(source, route.input, "param");
    const operationId = makeOperationId(method, fullPath);

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
      responses: route.output
        ? {
            [status]: {
              description: DEFAULT_RESPONSE_DESCRIPTION,
              content: {
                "application/json": { schema: route.output },
              },
            },
          }
        : {
            [status]: { description: DEFAULT_RESPONSE_DESCRIPTION },
          },
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
