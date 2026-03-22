/**
 * HTTP route handlers for the admin ORM server.
 * Each handler corresponds to a URL pattern registered in the router.
 *
 * Routes:
 *   GET  /                       → dashboard   GET  /:repoName              → document list (paginated)
 *   GET  /:repoName/create       → create form
 *   POST /:repoName/create       → submit create
 *   GET  /:repoName/:id/edit     → edit form (pre-filled)
 *   POST /:repoName/:id/edit     → submit update
 *   POST /:repoName/:id/delete   → delete document
 */

import { z } from "zod";
import type { ConfiguredRepository } from "../../repositories/types";
import type { RepositoryConfig } from "../../shared/types";
import { getInnerType, getShape, getTypeName } from "../../shared/zod-compat";
import { renderForm, zodToFields, type FieldDescriptor } from "./form-gen";
import type {
  ColumnMeta,
  FilterState,
  RelationalFieldMeta,
  WhereOp,
} from "./renderer";
import { renderDashboard, renderFormPage, renderList } from "./renderer";
import type { AnyReq, AnyRes, RouteParams } from "./router";

// ---------------------------------------------------------------------------
// Registry type
// ---------------------------------------------------------------------------

export interface AdminRepoEntry {
  name: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo: ConfiguredRepository<
    RepositoryConfig<any, any, any, any, any, any, any, any, any, any>
  >;
  schema: z.ZodObject<any>;
  /** document key field name (default: "docId") */
  documentKey?: string;
  /** Field name that stores the full Firestore document path (e.g. "documentPath") */
  pathKey?: string;
  /** Whether this repo is a collection group (subcollection) */
  isGroup?: boolean;
  /** Parent key field names needed to build a subcollection document ref (auto-detected from refCb) */
  parentKeys?: string[];
  /** Field name for the creation timestamp (auto-set on create) */
  createdKey?: string;
  /** List of columns to display in the table (defaults to schema keys) */
  listColumns?: string[];
  /** Page size for list view (default: 25) */
  pageSize?: number;
  /** Fields exposed in the filter bar (defaults to all schema keys) */
  filterableFields?: string[];
  /** Fields shown in the edit form (defaults to all schema fields if unset) */
  mutableFields?: string[];
  /** Fields shown in the create form (defaults to all schema fields if unset) */
  createFields?: string[];
  /** Whether delete is allowed (default: false) */
  allowDelete?: boolean;
  /**
   * Fields that link to another repository.
   * Populated automatically from the repo's relationalKeys.
   */
  relationalMeta?: RelationalFieldMeta[];
}

export type RepoRegistry = Record<string, AdminRepoEntry>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _idChars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a random 20-char alphanumeric ID matching Firestore's native format. */
function generateFirestoreId(): string {
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += _idChars.charAt(Math.floor(Math.random() * _idChars.length));
  }
  return id;
}

/**
 * Extract Firestore document path args from a document's stored path.
 * e.g. "posts/abc/comments/xyz" → ["abc", "xyz"] (the doc-ID segments).
 * Returns `undefined` when no usable path is available.
 */
function extractPathArgs(
  doc: Record<string, unknown>,
  pathKey?: string,
): string[] | undefined {
  if (!pathKey) return undefined;
  const fullPath = doc[pathKey];
  if (typeof fullPath !== "string" || !fullPath) return undefined;
  const segments = fullPath.split("/").filter(Boolean);
  // Doc IDs are at odd indices: col/id/col/id/...
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
  entry: AdminRepoEntry,
  docId: string,
): Promise<Record<string, unknown> | null> {
  const docKey = entry.documentKey ?? "docId";
  const getMethod =
    `by${docKey.charAt(0).toUpperCase()}${docKey.slice(1)}` as keyof typeof entry.repo.get;

  // Try direct get first
  if (typeof entry.repo.get[getMethod] === "function") {
    try {
      const doc = (await (entry.repo.get[getMethod] as Function)(
        docId,
      )) as Record<string, unknown> | null;
      if (doc) return doc;
    } catch {
      // Direct ref may fail for subcollections — fall through to query
    }
  }

  // Fallback: query-based lookup (works for collectionGroup)
  const results = await entry.repo.query.by({
    where: [[docKey, "==", docId]],
    limit: 1,
  });
  return (results[0] as Record<string, unknown>) ?? null;
}

function sendHtml(res: AnyRes, html: string, status = 200): void {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").send(html);
}

function redirect(res: AnyRes, to: string): void {
  res.status(302).set("Location", to).send("");
}

/**
 * Parse a flat form body (from `application/x-www-form-urlencoded`) into a
 * typed object using the Zod schema as guide.
 * Handles: dot-notation nested fields (e.g. address.street), JSON textarea
 * values, booleans (checkbox), numbers.
 */
function parseFormBody(
  raw: Record<string, string | string[] | undefined>,
  schema: z.ZodObject<any>,
): Record<string, unknown> {
  const shape = schema.shape;
  const result: Record<string, unknown> = {};

  for (const [key, zodField] of Object.entries(shape)) {
    const tn = resolveTypeName(zodField as z.ZodType);

    // ── ZodObject: prefer dot-notation sub-keys over raw JSON textarea ──────
    if (tn === "ZodObject") {
      // Check for explicit null marker first
      if (raw[key + "__isnull"] === "1") {
        result[key] = null;
        continue;
      }
      const subRaw: Record<string, string | string[] | undefined> = {};
      let hasDotKeys = false;
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith(`${key}.`)) {
          subRaw[k.slice(key.length + 1)] = v;
          hasDotKeys = true;
        }
      }
      if (hasDotKeys) {
        // Unwrap to the inner ZodObject schema and recurse
        let innerSchema: z.ZodType = zodField as z.ZodType;
        while (true) {
          const itn = getTypeName(innerSchema);
          if (
            itn === "ZodOptional" ||
            itn === "ZodNullable" ||
            itn === "ZodDefault"
          ) {
            innerSchema = getInnerType(innerSchema)!;
          } else break;
        }
        result[key] = parseFormBody(subRaw, innerSchema as z.ZodObject<any>);
        continue;
      }
      // Fallback: try to JSON-parse the textarea value
      const rawVal = raw[key];
      const strVal = Array.isArray(rawVal) ? rawVal[rawVal.length - 1] : rawVal;
      if (strVal) {
        try {
          result[key] = JSON.parse(strVal);
        } catch {
          result[key] = strVal;
        }
      }
      continue;
    }

    // ── All other types ─────────────────────────────────────────────────────
    const rawVal = raw[key];
    const strVal = Array.isArray(rawVal) ? rawVal[rawVal.length - 1] : rawVal;
    // Nullable field explicitly set to null via the toggle
    if (raw[key + "__isnull"] === "1") {
      result[key] = null;
      continue;
    }
    if (strVal === undefined || strVal === "") {
      // Checkbox unchecked → false; everything else → omit
      if (tn === "ZodBoolean") result[key] = false;
      continue;
    }

    switch (tn) {
      case "ZodBoolean":
        if (strVal === "__null__") {
          result[key] = null;
        } else {
          result[key] = strVal === "true" || strVal === "on" || strVal === "1";
        }
        break;
      case "ZodNumber":
      case "ZodBigInt":
        result[key] = Number(strVal);
        break;
      case "ZodDate":
        result[key] = new Date(strVal);
        break;
      case "ZodArray":
        try {
          result[key] = JSON.parse(strVal);
        } catch {
          result[key] = strVal;
        }
        break;
      default:
        // Try JSON for inline JSON textareas, fall back to string
        if (strVal.startsWith("{") || strVal.startsWith("[")) {
          try {
            result[key] = JSON.parse(strVal);
            break;
          } catch {
            /* fall through */
          }
        }
        result[key] = strVal;
    }
  }

  return result;
}

/**
 * Convert any date-like value to the "yyyy-MM-ddThh:mm" string required by
 * `<input type="datetime-local">`.
 * Handles: native Date, Firestore Timestamp ({_seconds, _nanoseconds}),
 * Firestore Timestamp with .toDate(), ISO strings, unix numbers.
 */
function toDatetimeLocal(val: unknown): string | null {
  let date: Date | null = null;

  if (val instanceof Date) {
    date = val;
  } else if (
    typeof val === "object" &&
    val !== null &&
    typeof (val as any).toDate === "function"
  ) {
    // Firestore Timestamp SDK object
    date = (val as any).toDate() as Date;
  } else if (
    typeof val === "object" &&
    val !== null &&
    "_seconds" in val &&
    "_nanoseconds" in val
  ) {
    // Plain serialized Firestore Timestamp { _seconds, _nanoseconds }
    date = new Date(
      (val as any)._seconds * 1000 +
        Math.floor((val as any)._nanoseconds / 1_000_000),
    );
  } else if (typeof val === "string" || typeof val === "number") {
    const d = new Date(val as string | number);
    if (!isNaN(d.getTime())) date = d;
  }

  if (!date || isNaN(date.getTime())) return null;

  // Format as local time yyyy-MM-ddThh:mm (what datetime-local expects)
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Resolve the innermost Zod type name (unwrapping Optional/Nullable/Default) */
function resolveTypeName(schema: z.ZodType): string {
  let s: z.ZodType = schema;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = getTypeName(s);
    if (tn === "ZodOptional" || tn === "ZodNullable" || tn === "ZodDefault") {
      s = getInnerType(s)!;
    } else {
      return tn;
    }
  }
}

/**
 * Prefill a Zod schema fields with existing document values.
 * For ZodObject fields, recurses into nested sub-fields using dot-notation keys
 * so that individual sub-inputs (e.g. address.street) are properly pre-filled.
 */
function prefillFromDoc(
  doc: Record<string, unknown>,
  schema: z.ZodObject<any>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = doc[key];
    // Sentinel "__null__" tells renderField to pre-check the null toggle
    if (val === null) {
      result[fullKey] = "__null__";
      continue;
    }
    if (val === undefined) continue;

    // Unwrap Optional/Nullable/Default to check inner type
    let innerSchema: z.ZodType = schema.shape[key] as z.ZodType;
    while (true) {
      const itn = getTypeName(innerSchema);
      if (
        itn === "ZodOptional" ||
        itn === "ZodNullable" ||
        itn === "ZodDefault"
      ) {
        innerSchema = getInnerType(innerSchema)!;
      } else break;
    }
    const innerTn = getTypeName(innerSchema);

    if (
      innerTn === "ZodObject" &&
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val)
    ) {
      // Recursively flatten nested object fields with dot-notation
      const nested = prefillFromDoc(
        val as Record<string, unknown>,
        innerSchema as z.ZodObject<any>,
        fullKey,
      );
      Object.assign(result, nested);
    } else if (innerTn === "ZodDate") {
      // Convert Date / Firestore Timestamp → datetime-local string
      const dtLocal = toDatetimeLocal(val);
      if (dtLocal !== null) result[fullKey] = dtLocal;
    } else if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      ("_seconds" in val || typeof (val as any).toDate === "function")
    ) {
      // Untyped Timestamp-like value: try datetime-local, fall back to JSON
      const dtLocal = toDatetimeLocal(val);
      result[fullKey] = dtLocal ?? JSON.stringify(val, null, 2);
    } else if (typeof val === "object") {
      result[fullKey] = JSON.stringify(val, null, 2);
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

/**
 * Recursively apply prefilled string values to a tree of FieldDescriptors.
 * Handles dot-notation keys for nested objects (e.g. "address.street").
 */
function applyPrefill(
  fields: FieldDescriptor[],
  prefilled: Record<string, string>,
): FieldDescriptor[] {
  return fields.map((f) => ({
    ...f,
    defaultValue: prefilled[f.name] ?? f.defaultValue,
    nested: f.nested ? applyPrefill(f.nested, prefilled) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Extract active filters from URL query params.
 * Params: fv_{field} = value, fo_{field} = operator (default ==)
 */
function parseFilters(
  query: Record<string, string>,
  validFields: Set<string>,
): FilterState[] {
  const validOps = new Set<string>([
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "array-contains",
    "array-contains-any",
  ]);
  const filters: FilterState[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (!k.startsWith("fv_")) continue;
    const field = k.slice(3);
    if (!validFields.has(field)) continue;
    const value = (v ?? "").trim();
    if (!value) continue;
    const opRaw = query[`fo_${field}`] ?? "==";
    const op = validOps.has(opRaw) ? (opRaw as WhereOp) : "==";
    filters.push({ field, op, value });
  }
  return filters;
}

/**
 * Convert FilterState[] to the where-clause tuples expected by the query engine.
 * Coerces string values to boolean/number when unambiguous.
 */
function filtersToWhere(filters: FilterState[]): [string, WhereOp, unknown][] {
  const coerce = (v: string): unknown => {
    if (v === "true") return true;
    if (v === "false") return false;
    if (v !== "" && !isNaN(Number(v))) return Number(v);
    return v;
  };
  return filters.map((f) => {
    if (f.op === "array-contains-any") {
      // CSV list → array, each element coerced
      const arr = f.value
        .split(",")
        .map((s) => coerce(s.trim()))
        .filter((s) => s !== "");
      return [f.field, f.op, arr];
    }
    return [f.field, f.op, coerce(f.value)];
  });
}

/** Build ColumnMeta for displayable columns, recursing into ZodObject sub-fields (dot-notation). */
function buildColumnMeta(
  columns: string[],
  schema: z.ZodObject<any>,
  prefix = "",
): ColumnMeta[] {
  const result: ColumnMeta[] = [];
  for (const col of columns) {
    const fullName = prefix ? `${prefix}.${col}` : col;
    const field = schema.shape[col] as z.ZodType | undefined;
    if (!field) {
      result.push({ name: fullName, zodType: "ZodString" });
      continue;
    }
    const zodType = resolveTypeName(field);
    if (zodType === "ZodObject") {
      // Unwrap wrappers to reach the inner ZodObject
      let inner: z.ZodType = field;
      while (true) {
        const itn = getTypeName(inner);
        if (
          itn === "ZodOptional" ||
          itn === "ZodNullable" ||
          itn === "ZodDefault"
        ) {
          inner = getInnerType(inner)!;
        } else break;
      }
      const subShape = getShape(inner);
      result.push(
        ...buildColumnMeta(
          Object.keys(subShape),
          inner as z.ZodObject<any>,
          fullName,
        ),
      );
    } else {
      result.push({ name: fullName, zodType });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Resolve the ZodType at a dot-notation path (e.g. "address.city") within a schema.
 * Returns null if the path cannot be resolved.
 */
function resolveZodAtPath(
  schema: z.ZodObject<any>,
  path: string,
): z.ZodType | null {
  const parts = path.split(".");
  let s: z.ZodType = schema as z.ZodType;
  for (const part of parts) {
    // Unwrap Optional / Nullable / Default wrappers
    while (true) {
      const itn = getTypeName(s);
      if (
        itn === "ZodOptional" ||
        itn === "ZodNullable" ||
        itn === "ZodDefault"
      ) {
        s = getInnerType(s)!;
      } else break;
    }
    const shape = getShape(s);
    if (!(part in shape)) return null;
    s = shape[part]!;
  }
  return s;
}

/**
 * Returns a Zod schema restricted to `fields` when defined.
 * Supports dot-notation paths (e.g. "address.city") by building partial
 * nested sub-schemas — useful for edit/create forms.
 * Falls back to the full schema if fields is undefined/empty.
 */
function getMutableSchema(
  schema: z.ZodObject<any>,
  fields: string[] | undefined,
): z.ZodObject<any> {
  if (!fields || fields.length === 0) return schema;

  const topLevel: string[] = [];
  // parent key → list of sub-field names requested
  const dotGroups = new Map<string, string[]>();

  for (const f of fields) {
    const dot = f.indexOf(".");
    if (dot === -1) {
      topLevel.push(f);
    } else {
      const parent = f.slice(0, dot);
      const child = f.slice(dot + 1);
      if (!dotGroups.has(parent)) dotGroups.set(parent, []);
      dotGroups.get(parent)!.push(child);
    }
  }

  const picked: Record<string, z.ZodType> = {};

  // Direct top-level fields
  for (const f of topLevel) {
    if (f in schema.shape) picked[f] = schema.shape[f]!;
  }

  // Partial nested objects for dot-notation entries
  for (const [parent, subFields] of dotGroups) {
    if (!(parent in schema.shape)) continue;
    // Unwrap to the inner ZodObject
    let inner: z.ZodType = schema.shape[parent] as z.ZodType;
    while (true) {
      const itn = getTypeName(inner);
      if (
        itn === "ZodOptional" ||
        itn === "ZodNullable" ||
        itn === "ZodDefault"
      ) {
        inner = getInnerType(inner)!;
      } else break;
    }
    if (getTypeName(inner) !== "ZodObject") {
      // Not an object — include as-is
      picked[parent] = schema.shape[parent]!;
      continue;
    }
    // Recurse: build a partial sub-schema for the requested sub-fields
    picked[parent] = getMutableSchema(inner as z.ZodObject<any>, subFields);
  }

  return z.object(picked);
}
/**
 * Compute the link base for all UI links.
 *
 * ── Emulator (FUNCTIONS_EMULATOR=true) ──────────────────────────────────────
 * Firebase emulator exposes functions at:
 *   http://localhost:5001/{GCLOUD_PROJECT}/{FUNCTION_REGION}/{FUNCTION_TARGET}/...
 * env vars set by the emulator:
 *   GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT  → project id
 *   FUNCTION_REGION                        → region (default: us-central1)
 *   FUNCTION_TARGET                        → function export name (e.g. "admin")
 *
 * ── Production ──────────────────────────────────────────────────────────────
 * Firebase proxy strips the prefix before reaching the handler, so links
 * are relative to "/" and `staticBasePath` is used as-is.
 */
function getLinkBase(_req: AnyReq, staticBasePath: string): string {
  const base = staticBasePath === "/" ? "" : staticBasePath.replace(/\/$/, "");

  if (process.env["FUNCTIONS_EMULATOR"] === "true") {
    const project =
      process.env["GCLOUD_PROJECT"] ??
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      "demo-project";
    const region = process.env["FUNCTION_REGION"] ?? "us-central1";
    // FUNCTION_TARGET uses dots (e.g. "sync.functions.syncAdmin") but the
    // emulator URL uses hyphens ("sync-functions-syncAdmin").
    const target = (process.env["FUNCTION_TARGET"] ?? "").replace(/\./g, "-");
    return `/${project}/${region}/${target}${base}`;
  }

  // Production: Firebase proxy strips the /{project}/{region}/{fn} prefix
  return base;
}

export function createAdminHandlers(registry: RepoRegistry, basePath: string) {
  // ── Dashboard ─────────────────────────────────────────────────────────────
  const handleDashboard = (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): void => {
    const lb = getLinkBase(req, basePath);
    const repos = Object.values(registry).map((e) => ({
      name: e.name,
      path: e.path,
    }));
    sendHtml(res, renderDashboard(repos, lb));
  };

  // ── List documents ────────────────────────────────────────────────────────
  const handleList = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    if (!repoName) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }

    const pageSize = entry.pageSize ?? 25;
    const query = (req.query ?? {}) as Record<string, string>;
    const cursorStr = query["cursor"];
    const dir = query["dir"] === "prev" ? "prev" : "next";

    // Sort
    const sortField = query["ob"] ?? "";
    const sortDir = (query["od"] === "desc" ? "desc" : "asc") as "asc" | "desc";
    const sortState = sortField
      ? { field: sortField, dir: sortDir }
      : undefined;

    // Rows per page (query ?ps= overrides config, capped at 200)
    const psRaw = parseInt(query["ps"] ?? "");
    const currentPageSize =
      Number.isFinite(psRaw) && psRaw > 0 ? Math.min(psRaw, 200) : pageSize;

    const allColumns = entry.listColumns ?? Object.keys(entry.schema.shape);
    const docKey = entry.documentKey ?? "docId";
    const columns = [docKey, ...allColumns.filter((c: string) => c !== docKey)];
    // Restrict filterable columns to filterableFields when defined.
    // Dot-notation paths (e.g. "address.city") are passed through directly;
    // top-level keys expand to sub-fields via buildColumnMeta as before.
    const filterableColumns: string[] = entry.filterableFields
      ? (() => {
          const out: string[] = [];
          for (const f of entry.filterableFields!) {
            if (f.includes(".")) {
              out.push(f); // direct dot-notation path
            } else if (allColumns.includes(f)) {
              out.push(f); // regular top-level key
            }
          }
          return out;
        })()
      : allColumns;
    // For dot-notation entries, resolve the correct ZodType; for top-level
    // keys, delegate to the existing buildColumnMeta (handles ZodObject expansion).
    const columnMeta: import("./renderer").ColumnMeta[] = (() => {
      const out: import("./renderer").ColumnMeta[] = [];
      for (const col of filterableColumns) {
        if (col.includes(".")) {
          const resolved = resolveZodAtPath(entry.schema, col);
          out.push({
            name: col,
            zodType: resolved ? resolveTypeName(resolved) : "ZodString",
          });
        } else {
          out.push(...buildColumnMeta([col], entry.schema));
        }
      }
      return out;
    })();

    // Parse and validate filters from query params
    // validFields built from columnMeta so dot-notation fields (address.city) are accepted
    const validFields = new Set(columnMeta.map((c) => c.name));
    const activeFilters = parseFilters(query, validFields);
    const whereFilters = filtersToWhere(activeFilters);

    // Attempt to rehydrate cursor
    let cursorSnapshot:
      | import("firebase-admin/firestore").DocumentSnapshot
      | undefined;
    if (cursorStr) {
      try {
        const colRef = entry.repo.ref as any;
        if (typeof colRef.doc === "function") {
          cursorSnapshot = await colRef.doc(cursorStr).get();
        }
      } catch {
        /* ignore */
      }
    }

    const result = await entry.repo.query.paginate({
      pageSize: currentPageSize,
      cursor: cursorSnapshot,
      // direction + where + orderBy are supported at runtime but not in the strict typed interface
      ...{ direction: dir },
      ...(whereFilters.length > 0 ? { where: whereFilters } : {}),
      ...(sortState
        ? {
            orderBy: [
              { field: sortState.field as any, direction: sortState.dir },
            ],
          }
        : {}),
    });

    const nextCursorId = result.nextCursor?.id ?? "";
    const prevCursorId = result.prevCursor?.id ?? "";
    const lb = getLinkBase(req, basePath);

    sendHtml(
      res,
      renderList(
        entry.name,
        result.data as Record<string, unknown>[],
        columns,
        lb,
        {
          hasPrev: result.hasPrevPage,
          hasNext: result.hasNextPage,
          prevCursor: prevCursorId,
          nextCursor: nextCursorId,
        },
        undefined,
        columnMeta,
        activeFilters,
        entry.allowDelete ?? false,
        entry.relationalMeta,
        sortState,
        currentPageSize,
      ),
    );
  };

  // ── Create form ───────────────────────────────────────────────────────────
  const handleCreateForm = (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): void => {
    const repoName = req.params["repoName"];
    if (!repoName) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }

    const lb = getLinkBase(req, basePath);
    const createSchema = getMutableSchema(entry.schema, entry.createFields);
    const fields = zodToFields(createSchema);
    const actionUrl = `${lb}/${entry.name}/create`;
    const formHtml = renderForm(fields, actionUrl, "POST", "Create document");

    sendHtml(res, renderFormPage(entry.name, formHtml, "create", null, lb));
  };

  // ── Create submit ─────────────────────────────────────────────────────────
  const handleCreateSubmit = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    if (!repoName) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }

    const lb = getLinkBase(req, basePath);
    const rawBody =
      (req.body as Record<string, string | string[] | undefined>) ?? {};
    const parsed = parseFormBody(rawBody, entry.schema);
    const createSchema = getMutableSchema(entry.schema, entry.createFields);
    const validation = createSchema.safeParse(parsed);

    if (!validation.success) {
      const fields = zodToFields(createSchema);
      const actionUrl = `${lb}/${entry.name}/create`;
      const formHtml = renderForm(fields, actionUrl, "POST", "Create document");
      const errorMsg = validation.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      sendHtml(
        res,
        renderFormPage(entry.name, formHtml, "create", null, lb, {
          type: "error",
          message: `Validation error: ${errorMsg}`,
        }),
        422,
      );
      return;
    }

    try {
      if (entry.isGroup && entry.parentKeys && entry.parentKeys.length > 0) {
        // Collection-group repos cannot use create(); use set() with parent path args.
        const data: Record<string, any> = { ...validation.data };
        // set() doesn't auto-set createdKey, so inject it here
        if (entry.createdKey) {
          data[entry.createdKey] = new Date();
        }
        const missingKeys = entry.parentKeys.filter((k) => !data[k]);
        if (missingKeys.length > 0) {
          throw new Error(
            `Missing parent key(s) for subcollection create: ${missingKeys.join(", ")}`,
          );
        }
        const parentIds = entry.parentKeys.map((k) => data[k] as string);
        const docKey = entry.documentKey ?? "docId";
        const docId = data[docKey] || generateFirestoreId();
        await entry.repo.set(...parentIds, docId, data);
      } else {
        await entry.repo.create(validation.data);
      }
      redirect(res, `${lb}/${entry.name}?flash=created`);
    } catch (err) {
      const createSchema2 = getMutableSchema(entry.schema, entry.createFields);
      const fields = zodToFields(createSchema2);
      const actionUrl = `${lb}/${entry.name}/create`;
      const formHtml = renderForm(fields, actionUrl, "POST", "Create document");
      sendHtml(
        res,
        renderFormPage(entry.name, formHtml, "create", null, lb, {
          type: "error",
          message: `Save error: ${(err as Error).message}`,
        }),
        500,
      );
    }
  };

  // ── Edit form ─────────────────────────────────────────────────────────────
  const handleEditForm = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    const docId = req.params["id"];
    if (!repoName || !docId) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }

    let doc: Record<string, unknown> | null = null;
    try {
      doc = await fetchDocById(entry, docId);
    } catch (err) {
      sendHtml(res, `Error fetching document: ${(err as Error).message}`, 500);
      return;
    }

    if (!doc) {
      sendHtml(res, "Document not found", 404);
      return;
    }

    const prefilled = prefillFromDoc(doc, entry.schema);
    const mutableSchema = getMutableSchema(entry.schema, entry.mutableFields);
    const fields = applyPrefill(zodToFields(mutableSchema), prefilled);

    const lb = getLinkBase(req, basePath);
    const actionUrl = `${lb}/${entry.name}/${encodeURIComponent(docId)}/edit`;
    const formHtml = renderForm(fields, actionUrl, "POST", "Save changes");

    sendHtml(res, renderFormPage(entry.name, formHtml, "edit", docId, lb));
  };

  // ── Edit submit ───────────────────────────────────────────────────────────
  const handleEditSubmit = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    const docId = req.params["id"];
    if (!repoName || !docId) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }
    const lb = getLinkBase(req, basePath);
    const rawBody =
      (req.body as Record<string, string | string[] | undefined>) ?? {};
    const parsed = parseFormBody(rawBody, entry.schema);

    // Partial validation for updates (restricted to mutableFields)
    const mutableSchema = getMutableSchema(entry.schema, entry.mutableFields);
    const partialSchema = mutableSchema.partial();
    const validation = partialSchema.safeParse(parsed);

    if (!validation.success) {
      const prefilled = Object.fromEntries(
        Object.entries(rawBody).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") : (v ?? ""),
        ]),
      );
      const fields = applyPrefill(zodToFields(mutableSchema), prefilled);
      const actionUrl = `${lb}/${entry.name}/${encodeURIComponent(docId)}/edit`;
      const formHtml = renderForm(fields, actionUrl, "POST", "Save changes");
      const errorMsg = validation.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      sendHtml(
        res,
        renderFormPage(entry.name, formHtml, "edit", docId, lb, {
          type: "error",
          message: `Validation error: ${errorMsg}`,
        }),
        422,
      );
      return;
    }

    try {
      // Fetch document to extract path args for subcollection repos
      const doc = await fetchDocById(entry, docId);
      const pathArgs = (doc && extractPathArgs(doc, entry.pathKey)) ?? [docId];
      await entry.repo.update(...pathArgs, validation.data);
      redirect(res, `${lb}/${entry.name}?flash=updated`);
    } catch (err) {
      const mutableSchema2 = getMutableSchema(
        entry.schema,
        entry.mutableFields,
      );
      const fields = zodToFields(mutableSchema2);
      const actionUrl = `${lb}/${entry.name}/${encodeURIComponent(docId)}/edit`;
      const formHtml = renderForm(fields, actionUrl, "POST", "Save changes");
      sendHtml(
        res,
        renderFormPage(entry.name, formHtml, "edit", docId, lb, {
          type: "error",
          message: `Save error: ${(err as Error).message}`,
        }),
        500,
      );
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    const docId = req.params["id"];
    if (!repoName || !docId) {
      sendHtml(res, "Bad request", 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendHtml(res, "Repository not found", 404);
      return;
    }
    if (!entry.allowDelete) {
      sendHtml(res, "Delete is not allowed for this repository", 403);
      return;
    }
    const lb = getLinkBase(req, basePath);
    try {
      // Fetch document to extract path args for subcollection repos
      const doc = await fetchDocById(entry, docId);
      const pathArgs = (doc && extractPathArgs(doc, entry.pathKey)) ?? [docId];
      await entry.repo.delete(...pathArgs);
      redirect(res, `${lb}/${entry.name}?flash=deleted`);
    } catch (err) {
      sendHtml(res, `Delete error: ${(err as Error).message}`, 500);
    }
  };

  return {
    handleDashboard,
    handleList,
    handleCreateForm,
    handleCreateSubmit,
    handleEditForm,
    handleEditSubmit,
    handleDelete,
  };
}
