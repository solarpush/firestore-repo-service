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

import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  coerceToDate,
  getDateHandling,
  maybeNormalize,
} from "../../shared/date-config";
import { toQueryError, type QueryErrorContext } from "../admin/index-url";
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

function sendJson<T>(c: any, data: ApiResponse<T>, status = 200) {
  const payload = maybeNormalize(data);
  return c.json(payload, status as any);
}

function sendSuccess<T>(
  c: any,
  data: T,
  meta?: ApiResponse["meta"],
  status = 200,
) {
  return sendJson(c, { success: true, data, meta }, status);
}

function sendError(c: any, error: string, status = 400) {
  return sendJson(c, { success: false, error }, status);
}

/**
 * Send a structured error response. When the underlying Firestore error is a
 * missing-index (`FAILED_PRECONDITION` / code 9), include `errorType: "index"`
 * and an `indexUrl` pointing to the Firebase Console index-creation wizard —
 * crucial for collection-group queries where the SDK omits the link.
 */
function sendQueryError(
  c: any,
  err: unknown,
  ctx: QueryErrorContext,
  fallbackMessage: string,
  verbose: boolean,
) {
  const qe = toQueryError(err, ctx);
  const isIndex = qe.type === "index";
  const status = isIndex ? 424 : 500;
  const message = isIndex
    ? qe.message
    : verbose && err instanceof Error
      ? err.message
      : fallbackMessage;
  const payload: ApiResponse = { success: false, error: message };
  if (isIndex) {
    payload.errorType = "index";
    if (qe.indexUrl) payload.indexUrl = qe.indexUrl;
  }
  return sendJson(c, payload, status);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

const _idChars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a random 20-char alphanumeric ID matching Firestore's native format.
 *
 * Uses a CSPRNG (`crypto.randomBytes`) — not `Math.random()` — so generated
 * ids are unpredictable, matching Firestore's own `doc().id`. Rejection
 * sampling (dropping the biased tail `>= 62*4`) keeps the distribution uniform
 * across the 62-char alphabet.
 */
function generateFirestoreId(): string {
  let id = "";
  while (id.length < 20) {
    const bytes = randomBytes(20);
    for (let i = 0; i < bytes.length && id.length < 20; i++) {
      const byte = bytes[i]!;
      if (byte >= _idChars.length * 4) continue; // drop biased tail (248..255)
      id += _idChars.charAt(byte % _idChars.length);
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// Zod schema helpers
// ---------------------------------------------------------------------------

/**
 * Recursively wrap z.date() with z.preprocess(coerceToDate) so that ISO strings,
 * Firestore Timestamps and {_seconds,_nanoseconds} payloads are accepted as input.
 * Only invoked when global date handling mode is "normalize".
 */
function wrapDateSchemas(schema: z.ZodType): z.ZodType {
  const def = (schema as any)._def ?? (schema as any).def;
  if (!def) return schema;
  const typeName = def.typeName ?? def.type;

  if (typeName === "ZodDate" || typeName === "date") {
    return z.preprocess((v) => coerceToDate(v) ?? v, schema as z.ZodDate);
  }
  if (typeName === "ZodObject" || typeName === "object") {
    const shape = (schema as z.ZodObject<any>).shape;
    const wrapped: Record<string, z.ZodType> = {};
    for (const [k, v] of Object.entries(shape)) {
      wrapped[k] = wrapDateSchemas(v as z.ZodType);
    }
    return z.object(wrapped);
  }
  if (typeName === "ZodArray" || typeName === "array") {
    const inner = def.element ?? def.type;
    if (inner) return z.array(wrapDateSchemas(inner));
  }
  if (typeName === "ZodOptional" || typeName === "optional") {
    const inner = def.innerType;
    if (inner) return wrapDateSchemas(inner).optional();
  }
  if (typeName === "ZodNullable" || typeName === "nullable") {
    const inner = def.innerType;
    if (inner) return wrapDateSchemas(inner).nullable();
  }
  if (typeName === "ZodDefault" || typeName === "default") {
    const inner = def.innerType;
    const dflt = def.defaultValue;
    if (inner) {
      const wrapped = wrapDateSchemas(inner);
      return typeof dflt === "function"
        ? wrapped.default(dflt())
        : wrapped.default(dflt);
    }
  }
  return schema;
}

/**
 * Pick only specified fields from a Zod schema, always excluding system-managed keys.
 *
 * - `fields` undefined or empty  → all schema fields minus systemKeys
 * - `fields` with values          → only those fields, minus systemKeys
 *
 * Security contract (issue #17): the returned schema is rebuilt from scratch
 * with `z.object(...)`, which **strips** any key not explicitly listed —
 * even when the user's root schema was declared `.passthrough()`. This
 * guarantees attacker-supplied keys (e.g. `__sync_version`, forged
 * timestamps, arbitrary metadata) can never reach Firestore via create /
 * update payloads. System keys are removed here too, so they cannot be
 * client-overridden.
 *
 * Note: a field explicitly declared as `z.any()` / `z.record(z.unknown())`
 * in the user schema is still accepted as-is by design — document such
 * free-form fields carefully, as their contents are persisted verbatim.
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
    const partialSchema = partial ? targetSchema.partial() : targetSchema;
    const finalSchema =
      getDateHandling() === "normalize"
        ? (wrapDateSchemas(partialSchema) as z.ZodObject<any>)
        : partialSchema;
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
  // ── Authorization helpers ───────────────────────────────────────────────
  /**
   * Default-deny gate: when the server has `auth` configured, reject any
   * operation without an explicit rule. When `auth` is absent, rules are
   * ignored entirely (open API).
   */
  async function assertRule<TCtx>(
    c: any,
    entry: CrudRepoEntry,
    op: keyof NonNullable<CrudRepoEntry["rules"]>,
    ctx: TCtx,
  ): Promise<boolean> {
    if (!entry.rules) return true;
    const rule = entry.rules?.[op] as
      | ((c: TCtx) => boolean | Promise<boolean>)
      | undefined;
    if (!rule) {
      sendError(c, `Operation "${op}" is not allowed for this repository`, 403);
      return false;
    }
    try {
      const ok = await rule(ctx);
      if (!ok) {
        return sendError(c, "Forbidden", 403);
        return false;
      }
      return true;
    } catch (err) {
      const message =
        verbose && err instanceof Error ? err.message : "Forbidden";
      return sendError(c, message, 403);
      return false;
    }
  }

  /** Apply `rules.filter` to every doc in a list; returns the filtered slice. */
  async function applyRowFilter<T extends Record<string, unknown>>(
    entry: CrudRepoEntry,
    user: any,
    params: Record<string, string>,
    docs: T[],
  ): Promise<T[]> {
    if (!entry.rules) return docs;
    const filter = entry.rules?.filter as
      | ((c: {
          user: any;
          doc: T;
          params: Record<string, string>;
        }) => boolean | Promise<boolean>)
      | undefined;
    if (!filter) return docs;
    const out: T[] = [];
    for (const doc of docs) {
      try {
        if (await filter({ user, doc, params })) out.push(doc);
      } catch {
        // exclude on error (fail closed)
      }
    }
    return out;
  }

  /** Pull the authenticated user from the request (may be undefined when auth is off). */
  function userOf(c: any): any {
    return c.get("user") ?? c.get("docsUser") ?? null;
  }

  // ── Helper to get repo entry ────────────────────────────────────────────
  function getRepoEntry(
    repoName: string | undefined,
    c: any,
  ): CrudRepoEntry | null {
    if (!repoName) {
      const parts = c.req.path.split("/");
      for (const part of parts) {
        if (registry[part]) {
          repoName = part;
          break;
        }
      }
    }
    if (!repoName || !registry[repoName]) {
      return null;
    }
    return registry[repoName] ?? null;
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
      args.push(segments[i]!);
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
  async function handleList(ctx: any): Promise<any> {
    const c = ctx.c;

    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    const user = userOf(c);
    if (
      !(await assertRule(c, entry, "list", {
        user,
        query: c.req.query(),
        params,
      }))
    )
      return;

    // Captured for error handling (so the catch can build an index URL)
    let ctxFilters: { field: string; op: any; value: string }[] = [];
    let ctxSort: { field: string; dir: "asc" | "desc" } | undefined;

    try {
      const query = c.req.query();
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
      ctxFilters = filters.map((f) => ({
        field: f.field,
        op: f.op,
        value: String(f.value ?? ""),
      }));
      if (orderBy) ctxSort = { field: orderBy, dir: orderDir };

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
        if (entry.orderableFields && !entry.orderableFields.includes(orderBy)) {
          return sendError(c, `Field not orderable: ${orderBy}`, 400);
        }
        queryOptions.orderBy = [{ field: orderBy, direction: orderDir }];
      }

      if (filters.length > 0) {
        queryOptions.where = [];
        for (const f of filters) {
          let finalValue = f.value;
          const fieldSchema = (entry.schema as any)?.shape?.[f.field];
          if (fieldSchema && typeof fieldSchema.safeParse === "function") {
            const parsed = fieldSchema.safeParse(f.value);
            if (parsed.success) {
              finalValue = parsed.data;
            } else {
              const messages = parsed.error.issues.map((e: any) => e.message).join(", ");
              return sendError(c, `Invalid filter value for '${f.field}': ${messages}`, 400);
            }
          }
          queryOptions.where.push([f.field, f.op, finalValue]);
        }
      }

      if (select) {
        queryOptions.select = select as any;
      }

      if (includes) {
        queryOptions.include = includes as any;
      }

      // Execute query
      const result = await entry.repo.query.paginate(queryOptions);
      const filteredItems = await applyRowFilter(
        entry,
        userOf(c),
        params,
        result.data,
      );

      const responseData: ListResponseData = {
        items: filteredItems,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        nextCursor: serializeCursor(result.nextCursor),
        prevCursor: serializeCursor(result.prevCursor),
      };

      return sendSuccess(c, responseData, {
        pageSize,
        hasMore: result.hasNextPage,
      });
    } catch (err) {
      sendQueryError(
        c,
        err,
        {
          ref: entry.repo.ref,
          path: entry.path,
          isGroup: !!entry.isGroup,
          filters: ctxFilters,
          sort: ctxSort,
        },
        "Failed to fetch documents",
        verbose,
      );
    }
  }

  // ── QUERY: POST /:repoName/query ────────────────────────────────────────
  // Advanced query endpoint supporting OR conditions, array filters, etc.
  async function handleQuery(ctx: any): Promise<any> {
    const c = ctx.c;

    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    const user = userOf(c);
    if (
      !(await assertRule(c, entry, "list", {
        user,
        query: ctx.input || {},
        params,
      }))
    )
      return;

    // Captured for error handling (so the catch can build an index URL)
    let ctxFilters: { field: string; op: any; value: string }[] = [];
    let ctxSort: { field: string; dir: "asc" | "desc" } | undefined;

    try {
      const body: QueryRequestBody = ctx.input || {};
      const pageSize = Math.min(body.pageSize || entry.pageSize, 100);
      const direction = body.direction === "prev" ? "prev" : "next";

      // Capture context for index URL fallback
      if (body.where) {
        ctxFilters = body.where.map((w) => ({
          field: String(w[0]),
          op: w[1] as any,
          value: String(w[2] ?? ""),
        }));
      }
      if (body.orderBy && body.orderBy[0]) {
        ctxSort = {
          field: body.orderBy[0].field,
          dir: body.orderBy[0].direction === "desc" ? "desc" : "asc",
        };
      }

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
              c,
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
              c,
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
                c,
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
        if (entry.orderableFields) {
          const allowed = new Set(entry.orderableFields);
          const invalid = body.orderBy.filter((o) => !allowed.has(o.field));
          if (invalid.length > 0) {
            sendError(
              c,
              `Fields not orderable: ${invalid.map((o) => o.field).join(", ")}`,
              400,
            );
            return;
          }
        }
        queryOptions.orderBy = body.orderBy;
      }

      // Select
      if (body.select && body.select.length > 0) {
        queryOptions.select = body.select;
      }

      // Execute query
      const result = await entry.repo.query.paginate(queryOptions);
      const filteredItems = await applyRowFilter(
        entry,
        userOf(c),
        params,
        result.data,
      );

      const responseData: ListResponseData = {
        items: filteredItems,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        nextCursor: serializeCursor(result.nextCursor),
        prevCursor: serializeCursor(result.prevCursor),
      };

      return sendSuccess(c, responseData, {
        pageSize,
        hasMore: result.hasNextPage,
      });
    } catch (err) {
      sendQueryError(
        c,
        err,
        {
          ref: entry.repo.ref,
          path: entry.path,
          isGroup: !!entry.isGroup,
          filters: ctxFilters,
          sort: ctxSort,
        },
        "Failed to query documents",
        verbose,
      );
    }
  }

  // ── GET: GET /:repoName/:id ─────────────────────────────────────────────
  async function handleGet(ctx: any): Promise<any> {
    const c = ctx.c;

    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    const id = params.id;
    if (!id) {
      return sendError(c, "Document ID required", 400);
    }

    try {
      const doc = await fetchDocById(entry, id);

      if (!doc) {
        return sendError(c, "Document not found", 404);
      }

      const user = userOf(c);
      if (
        !(await assertRule(c, entry, "get", {
          user,
          doc: doc as any,
          params,
        }))
      )
        return;

      // Apply row-level filter (404 if rejected, to avoid existence leakage)
      if (entry.rules?.filter) {
        try {
          const ok = await entry.rules.filter({
            user,
            doc: doc as any,
            params,
          });
          if (!ok) {
            return sendError(c, "Document not found", 404);
          }
        } catch {
          return sendError(c, "Document not found", 404);
        }
      }

      return sendSuccess(c, doc);
    } catch (err) {
      sendQueryError(
        c,
        err,
        {
          ref: entry.repo.ref,
          path: entry.path,
          isGroup: !!entry.isGroup,
          filters: [{ field: entry.documentKey, op: "==", value: id }],
        },
        "Failed to fetch document",
        verbose,
      );
    }
  }

  // ── CREATE: POST /:repoName ─────────────────────────────────────────────
  async function handleCreate(ctx: any): Promise<any> {
    const c = ctx.c;

    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    try {
      const body = ctx.input || {};

      const user = userOf(c);
      if (
        !(await assertRule(c, entry, "create", {
          user,
          body,
          params,
        }))
      )
        return;

      // Validate against schema
      const validation = validateData(
        entry.schema,
        body,
        entry.createFields,
        false,
        entry.systemKeys,
      );
      if (!validation.success) {
        return sendError(c, (validation as any).error, 400);
      }

      // Custom validation
      if (entry.validate) {
        const customError = await entry.validate(validation.data, "create");
        if (customError) {
          return sendError(c, customError, 400);
        }
      }

      // Create document
      let created: any;
      if (entry.isGroup && entry.parentKeys && entry.parentKeys.length > 0) {
        // Collection-group repos cannot use create(); use set() with parent path args.
        const data: Record<string, any> = { ...validation.data };
        // set() doesn't auto-set createdKey, so inject it here
        if (entry.createdKey) {
          data[entry.createdKey] = new Date();
        }
        const missingKeys = entry.parentKeys.filter((k) => !data[k]);
        if (missingKeys.length > 0) {
          sendError(
            c,
            `Missing parent key(s) for subcollection create: ${missingKeys.join(", ")}`,
            400,
          );
          return;
        }
        const parentIds = entry.parentKeys.map((k) => data[k] as string);
        const docId = data[entry.documentKey] || generateFirestoreId();
        created = await entry.repo.set(...parentIds, docId, data);
      } else {
        created = await entry.repo.create(validation.data as any);
      }

      return sendSuccess(c, created, undefined, 201);
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to create document";
      return sendError(c, message, 500);
    }
  }

  // ── UPDATE: PUT/PATCH /:repoName/:id ────────────────────────────────────
  async function handleUpdate(ctx: any, partial: boolean): Promise<any> {
    const c = ctx.c;
    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    const id = params.id;
    if (!id) {
      return sendError(c, "Document ID required", 400);
    }

    try {
      const body = ctx.input || {};

      // Fetch existing doc so the rule can authorize against current state
      const existingDoc = await fetchDocById(entry, id);
      if (!existingDoc) {
        return sendError(c, "Document not found", 404);
      }

      const user = userOf(c);
      if (
        !(await assertRule(c, entry, "update", {
          user,
          doc: existingDoc as any,
          body,
          params,
        }))
      )
        return;

      // Validate against schema
      const validation = validateData(
        entry.schema,
        body,
        entry.mutableFields,
        partial,
        entry.systemKeys,
      );
      if (!validation.success) {
        return sendError(c, (validation as any).error, 400);
      }

      // Custom validation
      if (entry.validate) {
        const customError = await entry.validate(validation.data, "update");
        if (customError) {
          return sendError(c, customError, 400);
        }
      }

      // Update document — derive path args for subcollections
      const pathArgs = extractPathArgs(existingDoc, entry.pathKey) ?? [id];
      const updated = await entry.repo.update(
        ...pathArgs,
        validation.data as any,
      );

      return sendSuccess(c, updated);
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to update document";
      return sendError(c, message, 500);
    }
  }

  // ── DELETE: DELETE /:repoName/:id ───────────────────────────────────────
  async function handleDelete(ctx: any): Promise<any> {
    const c = ctx.c;

    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    if (!entry.allowDelete) {
      return sendError(c, "Delete not allowed for this repository", 403);
    }

    const id = params.id;
    if (!id) {
      return sendError(c, "Document ID required", 400);
    }

    try {
      // Fetch first to authorize against current state and get path args
      const doc = await fetchDocById(entry, id);
      if (!doc) {
        return sendError(c, "Document not found", 404);
      }

      const user = userOf(c);
      if (
        !(await assertRule(c, entry, "delete", {
          user,
          doc: doc as any,
          params,
        }))
      )
        return;

      const pathArgs = extractPathArgs(doc, entry.pathKey) ?? [id];
      await entry.repo.delete(...pathArgs);
      return sendSuccess(c, { deleted: true });
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Failed to delete document";
      return sendError(c, message, 500);
    }
  }

  // ── OPTIONS: for CORS preflight ─────────────────────────────────────────
  function handleOptions(ctx: any): any {
    const c = ctx.c;
    return c.text("", 204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
  }

  // ── BATCH: POST /:repoName/batch ─────────────────────────────────────────
  async function handleBatch(ctx: any) {
    const c = ctx.c;
    const params = c.req.param();
    const entry = getRepoEntry(params.repoName, c);
    if (!entry) return sendError(c, `Repository not found`, 404);

    try {
      const body = ctx.input || {};
      if (!Array.isArray(body.operations)) {
        return sendError(c, "operations array is required", 400);
      }

      const user = userOf(c);

      const batch = entry.repo.batch.create();
      const results = [];

      for (const op of body.operations) {
        if (!op.type || !["create", "update", "delete"].includes(op.type)) {
          return sendError(c, "Invalid operation type", 400);
        }

        if (op.type === "create") {
          if (
            !(await assertRule(c, entry, "create", {
              user,
              body: op.data,
              params,
            }))
          )
            return;
          const validation = validateData(
            entry.schema,
            op.data,
            entry.createFields,
            false,
            entry.systemKeys,
          );
          if (!validation.success)
            return sendError(c, (validation as any).error, 400);

          let docId = op.data[entry.documentKey] || generateFirestoreId();
          const data = { ...validation.data };
          if (entry.createdKey) data[entry.createdKey] = new Date();

          if (entry.isGroup && entry.parentKeys) {
            const parentIds = entry.parentKeys.map(
              (k: string) => data[k] as string,
            );
            batch.set(...parentIds, docId, data);
          } else {
            batch.set(docId, data);
          }
          results.push({ op: "create", id: docId });
        } else if (op.type === "update") {
          if (!op.id) return sendError(c, "id required for update", 400);

          const existingDoc = await fetchDocById(entry, op.id);
          if (!existingDoc)
            return sendError(c, `Document ${op.id} not found`, 404);

          if (
            !(await assertRule(c, entry, "update", {
              user,
              doc: existingDoc as any,
              body: op.data,
              params,
            }))
          )
            return;

          const validation = validateData(
            entry.schema,
            op.data,
            entry.mutableFields,
            true,
            entry.systemKeys,
          );
          if (!validation.success)
            return sendError(c, (validation as any).error, 400);

          const pathArgs = extractPathArgs(existingDoc, entry.pathKey) ?? [
            op.id,
          ];
          batch.update(...pathArgs, validation.data);
          results.push({ op: "update", id: op.id });
        } else if (op.type === "delete") {
          if (!entry.allowDelete)
            return sendError(c, "Delete not allowed", 403);
          if (!op.id) return sendError(c, "id required for delete", 400);

          const doc = await fetchDocById(entry, op.id);
          if (!doc) return sendError(c, `Document ${op.id} not found`, 404);
          if (
            !(await assertRule(c, entry, "delete", {
              user,
              doc: doc as any,
              params,
            }))
          )
            return;

          const pathArgs = extractPathArgs(doc, entry.pathKey) ?? [op.id];
          batch.delete(...pathArgs);
          results.push({ op: "delete", id: op.id });
        }
      }

      await batch.commit();
      return sendSuccess(c, { results });
    } catch (err) {
      const message =
        verbose && err instanceof Error
          ? err.message
          : "Batch operation failed";
      return sendError(c, message, 500);
    }
  }

  return {
    handleList,
    handleQuery,
    handleGet,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleBatch,
    handleOptions,
  };
}
