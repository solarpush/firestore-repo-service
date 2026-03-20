/**
 * HTTP route handlers for the CRUD API server.
 *
 * Routes:
 *   GET    /:repoName           → list documents (paginated)
 *   GET    /:repoName/:id       → get single document
 *   POST   /:repoName           → create document
 *   PUT    /:repoName/:id       → update document (full)
 *   PATCH  /:repoName/:id       → update document (partial)
 *   DELETE /:repoName/:id       → delete document
 */

import { z } from "zod";
import type {
  ApiResponse,
  CrudRepoEntry,
  CrudRepoRegistry,
  ListResponseData,
  QueryRequestBody,
} from "./types";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson<T>(res: any, data: ApiResponse<T>, status = 200): void {
  res
    .status(status)
    .set("Content-Type", "application/json; charset=utf-8")
    .send(JSON.stringify(data));
}

function sendSuccess<T>(
  res: any,
  data: T,
  meta?: ApiResponse["meta"],
  status = 200,
): void {
  sendJson(res, { success: true, data, meta }, status);
}

function sendError(res: any, error: string, status = 400): void {
  sendJson(res, { success: false, error }, status);
}

// ---------------------------------------------------------------------------
// Zod schema helpers
// ---------------------------------------------------------------------------

/**
 * Pick only specified fields from a Zod schema, always excluding system-managed keys.
 *
 * - `fields` undefined or empty  → all schema fields minus systemKeys
 * - `fields` with values          → only those fields, minus systemKeys
 */
function pickSchemaFields(
  schema: z.ZodObject<any>,
  fields: string[] | undefined,
  systemKeys: string[] = [],
): z.ZodObject<any> {
  const shape = schema.shape;
  const picked: Record<string, z.ZodType> = {};

  const source = fields && fields.length > 0 ? fields : Object.keys(shape);

  for (const field of source) {
    if (systemKeys.includes(field)) continue;
    const topLevel = field.split(".")[0];
    if (topLevel && shape[topLevel]) {
      picked[topLevel] = shape[topLevel]!;
    }
  }

  return z.object(picked);
}

/**
 * Validate data against schema and return parsed result or error.
 */
function validateData(
  schema: z.ZodObject<any>,
  data: unknown,
  fields: string[] | undefined,
  partial = false,
  systemKeys: string[] = [],
):
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string } {
  try {
    const targetSchema = pickSchemaFields(schema, fields, systemKeys);
    const finalSchema = partial ? targetSchema.partial() : targetSchema;
    const parsed = finalSchema.parse(data);
    return { success: true, data: parsed as Record<string, unknown> };
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.issues.map(
        (e) => `${e.path.join(".")}: ${e.message}`,
      );
      return {
        success: false,
        error: `Validation failed: ${messages.join(", ")}`,
      };
    }
    return { success: false, error: "Validation failed" };
  }
}

// ---------------------------------------------------------------------------
// Filter parsing
// ---------------------------------------------------------------------------

type WhereOp =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any";

interface ParsedFilter {
  field: string;
  op: WhereOp;
  value: unknown;
}

/**
 * Parse query params into filter conditions.
 * Supports:
 *   - field=value           → field == value
 *   - field__op=value       → field op value (e.g., status__ne=draft → status != draft)
 *   - field__in=a,b,c       → field in [a, b, c]
 */
function parseFilters(
  query: Record<string, string | string[] | undefined>,
  filterableFields: string[] | undefined,
): ParsedFilter[] {
  const filters: ParsedFilter[] = [];
  const allowedFields = filterableFields ? new Set(filterableFields) : null;

  const opMap: Record<string, WhereOp> = {
    eq: "==",
    ne: "!=",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
    in: "in",
    nin: "not-in",
    contains: "array-contains",
    containsAny: "array-contains-any",
  };

  for (const [key, rawVal] of Object.entries(query)) {
    if (rawVal === undefined) continue;

    // Skip pagination/meta params
    if (
      ["cursor", "limit", "pageSize", "orderBy", "orderDir", "select"].includes(
        key,
      )
    )
      continue;

    const val = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    if (val === undefined || val === "") continue;

    // Parse field__op format
    const match = key.match(/^(\w+)__(\w+)$/);
    let field: string;
    let op: WhereOp = "==";

    if (match && match[1] && match[2]) {
      field = match[1];
      const opKey = match[2];
      if (opMap[opKey]) {
        op = opMap[opKey];
      } else {
        continue; // Unknown operator, skip
      }
    } else if (!match) {
      field = key;
    } else {
      continue; // Invalid match
    }

    // Check if field is filterable
    if (allowedFields && !allowedFields.has(field)) continue;

    // Parse value
    let parsedVal: unknown = val;

    // Handle "in" and "not-in" operators (comma-separated)
    if (op === "in" || op === "not-in" || op === "array-contains-any") {
      parsedVal = val.split(",").map((v) => parseValue(v.trim()));
    } else {
      parsedVal = parseValue(val);
    }

    filters.push({ field, op, value: parsedVal });
  }

  return filters;
}

/**
 * Parse a string value into appropriate type.
 */
function parseValue(val: string): unknown {
  // Boolean
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;

  // Number
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;

  // String
  return val;
}

// ---------------------------------------------------------------------------
// Cursor serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a Firestore DocumentSnapshot to a JSON-safe cursor object.
 */
function serializeCursor(
  snapshot: import("firebase-admin/firestore").DocumentSnapshot | undefined,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  return { docId: snapshot.id };
}

/**
 * Deserialize a cursor object back to a DocumentSnapshot.
 * Fetches the document from Firestore to get the actual snapshot.
 */
async function deserializeCursor(
  entry: CrudRepoEntry,
  cursor: unknown,
): Promise<import("firebase-admin/firestore").DocumentSnapshot | undefined> {
  if (!cursor || typeof cursor !== "object") return undefined;
  const docId = (cursor as Record<string, unknown>).docId;
  if (typeof docId !== "string") return undefined;

  try {
    // Get the collection reference from the repo
    const colRef = entry.repo
      .ref as import("firebase-admin/firestore").CollectionReference;
    if (typeof colRef.doc !== "function") return undefined;
    const snapshot = await colRef.doc(docId).get();
    return snapshot.exists ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Handlers factory
// ---------------------------------------------------------------------------

export function createCrudHandlers(
  registry: CrudRepoRegistry,
  basePath: string,
  verbose: boolean,
) {
  // ── Helper to get repo entry ────────────────────────────────────────────
  function getRepoEntry(
    repoName: string | undefined,
    res: any,
  ): CrudRepoEntry | null {
    if (!repoName || !registry[repoName]) {
      sendError(res, `Repository "${repoName}" not found`, 404);
      return null;
    }
    return registry[repoName];
  }

  /**
   * Extract Firestore document path args from a document's stored path.
   * e.g. "posts/abc/comments/xyz" → ["abc", "xyz"] (the doc-ID segments).
   */
  function extractPathArgs(
    doc: Record<string, unknown>,
    pathKey?: string,
  ): string[] | undefined {
    if (!pathKey) return undefined;
    const fullPath = doc[pathKey];
    if (typeof fullPath !== "string" || !fullPath) return undefined;
    const segments = fullPath.split("/").filter(Boolean);
    const args: string[] = [];
    for (let i = 1; i < segments.length; i += 2) {
      args.push(segments[i]);
    }
    return args.length > 0 ? args : undefined;
  }

  /**
   * Fetch a single document by its documentKey, with fallback to query
   * for collection-group repos where direct documentRef may fail.
   */
  async function fetchDocById(
    entry: CrudRepoEntry,
    docId: string,
  ): Promise<Record<string, unknown> | null> {
    const getterName = `by${entry.documentKey.charAt(0).toUpperCase()}${entry.documentKey.slice(1)}`;
    const getter = (entry.repo.get as any)[getterName];

    if (typeof getter === "function") {
      try {
        const doc = (await getter(docId)) as Record<string, unknown> | null;
        if (doc) return doc;
      } catch {
        // Direct ref may fail for subcollections — fall through to query
      }
    }

    const results = await entry.repo.query.by({
      where: [[entry.documentKey, "==", docId]],
      limit: 1,
    });
    return (results[0] as Record<string, unknown>) ?? null;
  }

  // ── LIST: GET /:repoName ────────────────────────────────────────────────
  async function handleList(req: any, res: any): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    try {
      const query = req.query ?? {};
      const pageSize = Math.min(
        Number(query.pageSize) || entry.pageSize,
        100, // Max page size
      );
      const cursor = query.cursor as string | undefined;
      const direction =
        (query.direction as string)?.toLowerCase() === "prev" ? "prev" : "next";
      const orderBy = query.orderBy as string | undefined;
      const orderDir =
        (query.orderDir as string)?.toLowerCase() === "desc" ? "desc" : "asc";
      const selectStr = query.select as string | undefined;
      const select = selectStr
        ? selectStr.split(",").map((s) => s.trim())
        : undefined;

      // Parse includes (relation population)
      let includes:
        | (string | { relation: string; select?: string[] })[]
        | undefined;
      if (entry.allowedIncludes && query.includes) {
        const rawIncludes =
          typeof query.includes === "string"
            ? query.includes.split(",").map((s: string) => s.trim())
            : Array.isArray(query.includes)
              ? query.includes
              : [];
        includes = rawIncludes.filter(
          (inc: string) =>
            typeof inc === "string" && entry.allowedIncludes!.includes(inc),
        );
        if (includes?.length === 0) includes = undefined;
      }

      // Parse filters
      const filters = parseFilters(query, entry.filterableFields);

      // Build query options
      const queryOptions: any = {
        pageSize,
        direction,
      };

      if (cursor) {
        try {
          const cursorObj =
            typeof cursor === "string" ? JSON.parse(cursor) : cursor;
          queryOptions.cursor = await deserializeCursor(entry, cursorObj);
        } catch {
          // Invalid cursor, ignore
        }
      }

      if (orderBy) {
        queryOptions.orderBy = [{ field: orderBy, direction: orderDir }];
      }

      if (filters.length > 0) {
        queryOptions.where = filters.map((f) => [f.field, f.op, f.value]);
      }

      if (select) {
        queryOptions.select = select as any;
      }

      if (includes) {
        queryOptions.include = includes as any;
      }

      // Execute query
      const result = await entry.repo.query.paginate(queryOptions);

      const responseData: ListResponseData = {
        items: result.data,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        nextCursor: serializeCursor(result.nextCursor),
        prevCursor: serializeCursor(result.prevCursor),
      };

      sendSuccess(res, responseData, {
        pageSize,
        hasMore: result.hasNextPage,
      });
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to fetch documents";
      sendError(res, message, 500);
    }
  }

  // ── QUERY: POST /:repoName/query ────────────────────────────────────────
  // Advanced query endpoint supporting OR conditions, array filters, etc.
  async function handleQuery(req: any, res: any): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    try {
      const body: QueryRequestBody = req.body ?? {};
      const pageSize = Math.min(body.pageSize || entry.pageSize, 100);
      const direction = body.direction === "prev" ? "prev" : "next";

      // Build query options
      const queryOptions: any = {
        pageSize,
        direction,
      };

      // Cursor
      if (body.cursor) {
        try {
          const cursorObj =
            typeof body.cursor === "string"
              ? JSON.parse(body.cursor)
              : body.cursor;
          queryOptions.cursor = await deserializeCursor(entry, cursorObj);
        } catch {
          // Invalid cursor, ignore
        }
      }

      // Includes (relation population)
      if (entry.allowedIncludes && body.includes && body.includes.length > 0) {
        const validIncludes = body.includes.filter((inc) => {
          if (typeof inc === "string") {
            return entry.allowedIncludes!.includes(inc);
          }
          if (
            typeof inc === "object" &&
            inc !== null &&
            "relation" in inc &&
            typeof inc.relation === "string"
          ) {
            return entry.allowedIncludes!.includes(inc.relation);
          }
          return false;
        });
        if (validIncludes.length > 0) {
          queryOptions.include = validIncludes as any;
        }
      }

      // Where conditions (AND)
      if (body.where && body.where.length > 0) {
        // Validate filterable fields if configured
        if (entry.filterableFields) {
          const allowed = new Set(entry.filterableFields);
          const invalid = body.where.filter((w) => !allowed.has(w[0]));
          if (invalid.length > 0) {
            sendError(
              res,
              `Fields not filterable: ${invalid.map((w) => w[0]).join(", ")}`,
              400,
            );
            return;
          }
        }
        queryOptions.where = body.where;
      }

      // OR where conditions (simple)
      if (body.orWhere && body.orWhere.length > 0) {
        if (entry.filterableFields) {
          const allowed = new Set(entry.filterableFields);
          const invalid = body.orWhere.filter((w) => !allowed.has(w[0]));
          if (invalid.length > 0) {
            sendError(
              res,
              `Fields not filterable: ${invalid.map((w) => w[0]).join(", ")}`,
              400,
            );
            return;
          }
        }
        queryOptions.orWhere = body.orWhere;
      }

      // OR where groups (advanced)
      if (body.orWhereGroups && body.orWhereGroups.length > 0) {
        if (entry.filterableFields) {
          const allowed = new Set(entry.filterableFields);
          for (const group of body.orWhereGroups) {
            const invalid = group.filter((w) => !allowed.has(w[0]));
            if (invalid.length > 0) {
              sendError(
                res,
                `Fields not filterable: ${invalid.map((w) => w[0]).join(", ")}`,
                400,
              );
              return;
            }
          }
        }
        queryOptions.orWhereGroups = body.orWhereGroups;
      }

      // Order by
      if (body.orderBy && body.orderBy.length > 0) {
        queryOptions.orderBy = body.orderBy;
      }

      // Select
      if (body.select && body.select.length > 0) {
        queryOptions.select = body.select;
      }

      // Execute query
      const result = await entry.repo.query.paginate(queryOptions);

      const responseData: ListResponseData = {
        items: result.data,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        nextCursor: serializeCursor(result.nextCursor),
        prevCursor: serializeCursor(result.prevCursor),
      };

      sendSuccess(res, responseData, {
        pageSize,
        hasMore: result.hasNextPage,
      });
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to query documents";
      sendError(res, message, 500);
    }
  }

  // ── GET: GET /:repoName/:id ─────────────────────────────────────────────
  async function handleGet(req: any, res: any): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    const id = params.id;
    if (!id) {
      sendError(res, "Document ID required", 400);
      return;
    }

    try {
      const doc = await fetchDocById(entry, id);

      if (!doc) {
        sendError(res, "Document not found", 404);
        return;
      }

      sendSuccess(res, doc);
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to fetch document";
      sendError(res, message, 500);
    }
  }

  // ── CREATE: POST /:repoName ─────────────────────────────────────────────
  async function handleCreate(req: any, res: any): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    try {
      const body = req.body ?? {};

      // Validate against schema
      const validation = validateData(
        entry.schema,
        body,
        entry.createFields,
        false,
        entry.systemKeys,
      );
      if (!validation.success) {
        sendError(res, validation.error, 400);
        return;
      }

      // Custom validation
      if (entry.validate) {
        const customError = await entry.validate(validation.data, "create");
        if (customError) {
          sendError(res, customError, 400);
          return;
        }
      }

      // Create document
      const created = await entry.repo.create(validation.data as any);

      sendSuccess(res, created, undefined, 201);
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to create document";
      sendError(res, message, 500);
    }
  }

  // ── UPDATE: PUT/PATCH /:repoName/:id ────────────────────────────────────
  async function handleUpdate(
    req: any,
    res: any,
    partial: boolean,
  ): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    const id = params.id;
    if (!id) {
      sendError(res, "Document ID required", 400);
      return;
    }

    try {
      const body = req.body ?? {};

      // Validate against schema
      const validation = validateData(
        entry.schema,
        body,
        entry.mutableFields,
        partial,
        entry.systemKeys,
      );
      if (!validation.success) {
        sendError(res, validation.error, 400);
        return;
      }

      // Custom validation
      if (entry.validate) {
        const customError = await entry.validate(validation.data, "update");
        if (customError) {
          sendError(res, customError, 400);
          return;
        }
      }

      // Update document — fetch first to get path args for subcollections
      const existingDoc = await fetchDocById(entry, id);
      const pathArgs =
        (existingDoc && extractPathArgs(existingDoc, entry.pathKey)) ?? [id];
      const updated = await entry.repo.update(
        ...pathArgs,
        validation.data as any,
      );

      sendSuccess(res, updated);
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to update document";
      sendError(res, message, 500);
    }
  }

  // ── DELETE: DELETE /:repoName/:id ───────────────────────────────────────
  async function handleDelete(req: any, res: any): Promise<void> {
    const params = req.params || {};
    const entry = getRepoEntry(params.repoName, res);
    if (!entry) return;

    if (!entry.allowDelete) {
      sendError(res, "Delete not allowed for this repository", 403);
      return;
    }

    const id = params.id;
    if (!id) {
      sendError(res, "Document ID required", 400);
      return;
    }

    try {
      // Fetch first to get path args for subcollections
      const doc = await fetchDocById(entry, id);
      const pathArgs =
        (doc && extractPathArgs(doc, entry.pathKey)) ?? [id];
      await entry.repo.delete(...pathArgs);
      sendSuccess(res, { deleted: true });
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to delete document";
      sendError(res, message, 500);
    }
  }

  // ── OPTIONS: for CORS preflight ─────────────────────────────────────────
  function handleOptions(req: any, res: any): void {
    res
      .status(204)
      .set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      )
      .set("Access-Control-Allow-Headers", "Content-Type, Authorization")
      .set("Access-Control-Max-Age", "86400")
      .send("");
  }

  return {
    handleList,
    handleQuery,
    handleGet,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleOptions,
  };
}
