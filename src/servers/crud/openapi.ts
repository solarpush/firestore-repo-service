/**
 * OpenAPI 3.1 specification generator for the CRUD server.
 *
 * Introspects each `CrudRepoEntry` and uses Zod 4's native `z.toJSONSchema()`
 * to produce a fully typed OpenAPI document ready for Scalar UI or codegen.
 *
 * @module servers/crud/openapi
 */

import { z } from "zod";
import type { CrudRepoEntry, CrudRepoRegistry } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal subset of an OpenAPI 3.1 document we produce. */
export interface OpenAPIDocument {
  openapi: "3.1.0";
  info: OpenAPIInfo;
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
}

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

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
}

interface OpenAPIOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, Record<string, unknown>>;
  security?: Record<string, string[]>[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Zod schema to a JSON Schema object suitable for OpenAPI 3.1. */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: "openapi-3.1" }) as Record<
      string,
      unknown
    >;
  } catch {
    // Fallback for unsupported types
    return { type: "object" };
  }
}

/** Wraps a JSON Schema in a `#/components/schemas/<name>` $ref. */
function schemaRef(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` };
}

/** Standard error response schema. */
function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: schemaRef("ErrorResponse"),
      },
    },
  };
}

/** Standard success response wrapping data. */
function successResponse(
  description: string,
  dataSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", enum: [true] },
            data: dataSchema,
          },
          required: ["success", "data"],
        },
      },
    },
  };
}

/** Build list response with pagination metadata. */
function listResponse(
  itemSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description: "Paginated list of documents",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", enum: [true] },
            data: {
              type: "object",
              properties: {
                items: { type: "array", items: itemSchema },
                nextCursor: {
                  oneOf: [{ type: "object" }, { type: "null" }],
                },
                prevCursor: {
                  oneOf: [{ type: "object" }, { type: "null" }],
                },
                hasNextPage: { type: "boolean" },
                hasPrevPage: { type: "boolean" },
              },
              required: ["items", "hasNextPage", "hasPrevPage"],
            },
            meta: {
              type: "object",
              properties: {
                pageSize: { type: "integer" },
                hasMore: { type: "boolean" },
                cursor: {
                  oneOf: [{ type: "string" }, { type: "null" }],
                },
              },
            },
          },
          required: ["success", "data"],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Pagination / filter query parameters (shared across list endpoints)
// ---------------------------------------------------------------------------

function paginationParams(entry: CrudRepoEntry): Record<string, unknown>[] {
  return [
    {
      name: "pageSize",
      in: "query",
      schema: { type: "integer", default: entry.pageSize, maximum: 100 },
      description: "Number of items per page",
    },
    {
      name: "cursor",
      in: "query",
      schema: { type: "string" },
      description: "Base64 pagination cursor",
    },
    {
      name: "orderBy",
      in: "query",
      schema: { type: "string" },
      description: "Field name to order by",
    },
    {
      name: "orderDir",
      in: "query",
      schema: { type: "string", enum: ["asc", "desc"] },
      description: "Order direction",
    },
    {
      name: "select",
      in: "query",
      schema: { type: "string" },
      description: "Comma-separated list of fields to return",
    },
  ];
}

function filterParams(entry: CrudRepoEntry): Record<string, unknown>[] {
  const fields = entry.filterableFields ?? Object.keys(entry.schema.shape);
  const ops = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "contains"];

  const params: Record<string, unknown>[] = [];
  for (const field of fields) {
    // Direct equality filter: ?field=value
    params.push({
      name: field,
      in: "query",
      schema: { type: "string" },
      description: `Filter by ${field} (equality)`,
    });
    // Operator filters: ?field__op=value
    for (const op of ops) {
      params.push({
        name: `${field}__${op}`,
        in: "query",
        schema: { type: "string" },
        description: `Filter ${field} with operator ${op}`,
      });
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Query body schema (POST /query)
// ---------------------------------------------------------------------------

function queryBodySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      where: {
        type: "array",
        items: {
          type: "array",
          items: {},
          minItems: 3,
          maxItems: 3,
        },
        description: "AND conditions: [field, operator, value][]",
      },
      orWhere: {
        type: "array",
        items: {
          type: "array",
          items: {},
          minItems: 3,
          maxItems: 3,
        },
        description: "Simple OR conditions (each independently OR'd)",
      },
      orWhereGroups: {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "array",
            items: {},
            minItems: 3,
            maxItems: 3,
          },
        },
        description: "Advanced OR groups (AND within, OR across groups)",
      },
      orderBy: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field"],
        },
      },
      select: {
        type: "array",
        items: { type: "string" },
        description: "Fields to select (projection)",
      },
      pageSize: {
        type: "integer",
        maximum: 100,
        description: "Number of items per page",
      },
      cursor: {
        oneOf: [{ type: "string" }, { type: "object" }],
        description: "Pagination cursor",
      },
      direction: {
        type: "string",
        enum: ["next", "prev"],
        description: "Pagination direction",
      },
      includes: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                relation: { type: "string" },
                select: { type: "array", items: { type: "string" } },
              },
              required: ["relation"],
            },
          ],
        },
        description: "Relations to include (populate)",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Path generation per repo entry
// ---------------------------------------------------------------------------

function buildPathsForEntry(
  entry: CrudRepoEntry,
  base: string,
  modelSchemaName: string,
  createSchemaName: string | null,
  updateSchemaName: string | null,
): Record<string, Record<string, OpenAPIOperation>> {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};
  const tag = entry.name;
  const collectionPath = `${base}/${entry.name}`;
  const documentPath = `${collectionPath}/{${entry.documentKey}}`;

  const idParam = {
    name: entry.documentKey,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `Unique document identifier`,
  };

  // ── GET /:repo → list ──────────────────────────────────────────────
  paths[collectionPath] = {
    get: {
      operationId: `list${capitalize(entry.name)}`,
      summary: `List ${entry.name} (paginated)`,
      tags: [tag],
      parameters: [...paginationParams(entry), ...filterParams(entry)],
      responses: {
        "200": listResponse(schemaRef(modelSchemaName)),
        "500": errorResponse("Internal server error"),
      },
    },
    // ── POST /:repo → create ────────────────────────────────────────
    post: {
      operationId: `create${capitalize(entry.name)}`,
      summary: `Create a ${singularize(entry.name)}`,
      tags: [tag],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: schemaRef(createSchemaName ?? modelSchemaName),
          },
        },
      },
      responses: {
        "201": successResponse("Document created", schemaRef(modelSchemaName)),
        "400": errorResponse("Validation error"),
        "500": errorResponse("Internal server error"),
      },
    },
  };

  // ── POST /:repo/query → advanced query ────────────────────────────
  paths[`${collectionPath}/query`] = {
    post: {
      operationId: `query${capitalize(entry.name)}`,
      summary: `Query ${entry.name} with advanced filters`,
      tags: [tag],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: schemaRef("QueryRequestBody"),
          },
        },
      },
      responses: {
        "200": listResponse(schemaRef(modelSchemaName)),
        "400": errorResponse("Invalid query"),
        "500": errorResponse("Internal server error"),
      },
    },
  };

  // ── Single-document paths ────────────────────────────────────────
  const docOps: Record<string, OpenAPIOperation> = {};

  // GET /:repo/:id
  docOps.get = {
    operationId: `get${capitalize(singularize(entry.name))}`,
    summary: `Get a single ${singularize(entry.name)}`,
    tags: [tag],
    parameters: [idParam],
    responses: {
      "200": successResponse("Document found", schemaRef(modelSchemaName)),
      "404": errorResponse("Document not found"),
      "500": errorResponse("Internal server error"),
    },
  };

  // PUT /:repo/:id (full update)
  docOps.put = {
    operationId: `update${capitalize(singularize(entry.name))}`,
    summary: `Update a ${singularize(entry.name)} (full replace)`,
    tags: [tag],
    parameters: [idParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: schemaRef(updateSchemaName ?? modelSchemaName),
        },
      },
    },
    responses: {
      "200": successResponse("Document updated", schemaRef(modelSchemaName)),
      "400": errorResponse("Validation error"),
      "404": errorResponse("Document not found"),
      "500": errorResponse("Internal server error"),
    },
  };

  // PATCH /:repo/:id (partial update)
  docOps.patch = {
    operationId: `patch${capitalize(singularize(entry.name))}`,
    summary: `Partially update a ${singularize(entry.name)}`,
    tags: [tag],
    parameters: [idParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            allOf: [schemaRef(updateSchemaName ?? modelSchemaName)],
            description: "All fields are optional for partial updates",
          },
        },
      },
    },
    responses: {
      "200": successResponse("Document patched", schemaRef(modelSchemaName)),
      "400": errorResponse("Validation error"),
      "404": errorResponse("Document not found"),
      "500": errorResponse("Internal server error"),
    },
  };

  // DELETE /:repo/:id (only if allowDelete)
  if (entry.allowDelete) {
    docOps.delete = {
      operationId: `delete${capitalize(singularize(entry.name))}`,
      summary: `Delete a ${singularize(entry.name)}`,
      tags: [tag],
      parameters: [idParam],
      responses: {
        "200": successResponse("Document deleted", {
          type: "object",
          properties: { id: { type: "string" } },
        }),
        "404": errorResponse("Document not found"),
        "500": errorResponse("Internal server error"),
      },
    };
  }

  paths[documentPath] = docOps;

  return paths;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a full OpenAPI 3.1 specification from a `CrudRepoRegistry`.
 *
 * Uses Zod 4's native `z.toJSONSchema()` to convert each repo's schema
 * into a JSON Schema component, then assembles paths for the standard
 * CRUD endpoints.
 *
 * @example
 * ```ts
 * import { generateOpenAPISpec } from "@lpdjs/firestore-repo-service/servers/crud";
 *
 * const spec = generateOpenAPISpec(registry, "/api", {
 *   title: "My API",
 *   version: "1.0.0",
 *   servers: [{ url: "https://my-api.example.com" }],
 *   auth: "bearer",
 * });
 *
 * // Write to file
 * fs.writeFileSync("openapi.json", JSON.stringify(spec, null, 2));
 * ```
 */
export function generateOpenAPISpec(
  registry: CrudRepoRegistry,
  basePath: string,
  options: OpenAPISpecOptions = {},
): OpenAPIDocument {
  const {
    title = "CRUD API",
    version = "1.0.0",
    description,
    servers,
    auth = false,
  } = options;

  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");

  // ── Components: schemas ───────────────────────────────────────────
  const schemas: Record<string, Record<string, unknown>> = {};
  const allPaths: Record<string, Record<string, OpenAPIOperation>> = {};
  const tags: { name: string; description?: string }[] = [];

  // Shared schemas
  schemas["ErrorResponse"] = {
    type: "object",
    properties: {
      success: { type: "boolean", enum: [false] },
      error: { type: "string" },
    },
    required: ["success", "error"],
  };

  schemas["QueryRequestBody"] = queryBodySchema();

  // Per-repo schemas & paths
  for (const [name, entry] of Object.entries(registry)) {
    const modelName = capitalize(singularize(name));
    const createName = `${modelName}Create`;
    const updateName = `${modelName}Update`;

    // Full model schema
    schemas[modelName] = zodToJsonSchema(entry.schema);

    // Helper: build a filtered shape (respects systemKeys + field list)
    const buildShape = (
      fieldList: string[] | undefined,
    ): Record<string, z.ZodType> => {
      const source =
        fieldList && fieldList.length > 0
          ? fieldList
          : Object.keys(entry.schema.shape);
      const shape: Record<string, z.ZodType> = {};
      for (const f of source) {
        const top = f.split(".")[0];
        if (top && entry.schema.shape[top] && !entry.systemKeys.includes(top)) {
          shape[top] = entry.schema.shape[top];
        }
      }
      return shape;
    };

    // Create schema
    let createSchemaName: string | null = null;
    const createShape = buildShape(entry.createFields);
    if (Object.keys(createShape).length > 0) {
      schemas[createName] = zodToJsonSchema(z.object(createShape));
      createSchemaName = createName;
    }

    // Update schema
    let updateSchemaName: string | null = null;
    const updateShape = buildShape(entry.mutableFields);
    if (Object.keys(updateShape).length > 0) {
      schemas[updateName] = zodToJsonSchema(z.object(updateShape));
      updateSchemaName = updateName;
    }

    // Build paths
    const entryPaths = buildPathsForEntry(
      entry,
      base,
      modelName,
      createSchemaName,
      updateSchemaName,
    );
    Object.assign(allPaths, entryPaths);

    // Tag
    tags.push({
      name,
      description: `Operations on ${name} (collection: ${entry.path})`,
    });
  }

  // ── Security ──────────────────────────────────────────────────────
  const securitySchemes: Record<string, Record<string, unknown>> = {};
  let security: Record<string, string[]>[] | undefined;

  if (auth === "basic") {
    securitySchemes["basicAuth"] = {
      type: "http",
      scheme: "basic",
    };
    security = [{ basicAuth: [] }];
  } else if (auth === "bearer") {
    securitySchemes["bearerAuth"] = {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    };
    security = [{ bearerAuth: [] }];
  }

  // ── Assemble ──────────────────────────────────────────────────────
  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: {
      title,
      version,
      ...(description ? { description } : {}),
    },
    ...(servers && servers.length > 0 ? { servers } : {}),
    paths: allPaths,
    components: {
      schemas,
      ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    },
    ...(security ? { security } : {}),
    tags,
  };

  return doc;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Naive singularize: strip trailing 's' for display. */
function singularize(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes"))
    return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}
