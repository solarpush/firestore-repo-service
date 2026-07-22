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

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ConfiguredRepository } from "../../repositories/types";
import type { RepositoryConfig } from "../../shared/types";
import {
  getEffectInnerType,
  getEnumValues,
  getInnerType,
  getLiteralValue,
  getNativeEnumValues,
  getShape,
  getTypeName,
  getUnionOptions,
} from "../../shared/zod-compat";
import { getLinkBase as getLinkBaseShared } from "../utils/link-base";
import { renderForm, zodToFields, type FieldDescriptor } from "./form-gen";
import { isMissingIndexError, toQueryError } from "./index-url";
import type {
  ColumnMeta,
  FilterState,
  RelationalFieldMeta,
  WhereOp,
} from "./renderer";
import {
  renderDashboard,
  renderFormPage,
  renderList,
  renderPage,
} from "./renderer";
import type { AnyReq, AnyRes, RouteParams } from "./router";

// ---------------------------------------------------------------------------
// Registry type
// ---------------------------------------------------------------------------

export interface AdminRepoEntry {
  name: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo: ConfiguredRepository<
    RepositoryConfig<any, any, any, any, any, any, any, any, any, any, any>
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
  /**
   * Auto-detected from `repo.history`. When true, the admin renders an
   * extra "History" button on each row and exposes a dedicated route at
   * `GET /:repoName/:id/history` that lists the change-log entries.
   */
  historyEnabled?: boolean;
  /** Subcollection name used to store history docs (display only). */
  historySubcollection?: string;
}

export type RepoRegistry = Record<string, AdminRepoEntry>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _idChars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a random 20-char alphanumeric ID matching Firestore's native format.
 * Uses a CSPRNG (`crypto.randomBytes`) with rejection sampling for a uniform,
 * unpredictable id — see issue #02.
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

/**
 * Rehydrate a cursor snapshot for both root collections and subcollections (collection groups).
 */
async function rehydrateAdminCursor(
  entry: AdminRepoEntry,
  cursorStr: string,
): Promise<import("firebase-admin/firestore").DocumentSnapshot | undefined> {
  if (!cursorStr) return undefined;
  try {
    const colRef = entry.repo.ref as any;
    const firestore = colRef?.firestore;

    // 1. If cursorStr is a JSON string
    if (cursorStr.startsWith("{")) {
      try {
        const parsed = JSON.parse(cursorStr);
        if (parsed.docPath && firestore && typeof firestore.doc === "function") {
          const snap = await firestore.doc(parsed.docPath).get();
          if (snap.exists) return snap;
        }
        if (parsed.docId) cursorStr = parsed.docId;
      } catch {
        /* ignore */
      }
    }

    // 2. If cursorStr is a full document path
    if (cursorStr.includes("/") && firestore && typeof firestore.doc === "function") {
      const snap = await firestore.doc(cursorStr).get();
      if (snap.exists) return snap;
    }

    // 3. Root collection fallback
    if (typeof colRef.doc === "function") {
      const snap = await colRef.doc(cursorStr).get();
      if (snap.exists) return snap;
    }
  } catch {
    /* ignore */
  }
  return undefined;
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

/**
 * Build a `flash` payload (with optional "Create Index" CTA) from a Firestore
 * error raised while loading a single document. Returns `undefined` if the
 * error is not interesting enough to render as a structured alert.
 */
function flashFromDocFetchError(
  entry: AdminRepoEntry,
  docId: string,
  err: unknown,
): {
  type: "warning" | "error";
  message: string;
  action?: { href: string; label: string; external?: boolean };
} {
  const docKey = entry.documentKey ?? "docId";
  const qe = toQueryError(err, {
    ref: entry.repo.ref,
    path: entry.path,
    isGroup: !!entry.isGroup,
    filters: [{ field: docKey, op: "==", value: docId }],
  });
  if (qe.type === "index") {
    return {
      type: "warning",
      message:
        "Loading this document requires a composite index that does not exist yet.",
      ...(qe.indexUrl
        ? {
            action: {
              href: qe.indexUrl,
              label: "Create Index →",
              external: true,
            },
          }
        : {}),
    };
  }
  return {
    type: "error",
    message: qe.message,
  };
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
    const innerSchema = resolveInnerSchema(zodField as z.ZodType);
    const tn = getTypeName(innerSchema);

    // Determine if it should be processed as an object (has dot-keys) or date
    let isObjectLike = tn === "ZodObject";
    let objectSchema: z.ZodType = innerSchema;
    let isDateUnion = false;

    if (tn === "ZodUnion") {
      const options = getUnionOptions(innerSchema);
      if (options.some((opt) => getTypeName(opt) === "ZodDate")) {
        isDateUnion = true;
      }
      const geoOpt = options.find((opt) => {
        if (getTypeName(opt) === "ZodObject") {
          const s = getShape(opt);
          return "latitude" in s && "longitude" in s;
        }
        return false;
      });
      if (geoOpt) {
        isObjectLike = true;
        objectSchema = geoOpt;
      }
    }

    if (raw[key + "__isnull"] === "1") {
      result[key] = null;
      continue;
    }

    // ── ZodObject: prefer dot-notation sub-keys over raw JSON textarea ──────
    if (isObjectLike) {
      const subRaw: Record<string, string | string[] | undefined> = {};
      let hasDotKeys = false;
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith(`${key}.`)) {
          subRaw[k.slice(key.length + 1)] = v;
          hasDotKeys = true;
        }
      }
      if (hasDotKeys) {
        result[key] = parseFormBody(subRaw, objectSchema as z.ZodObject<any>);
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

    if (strVal === undefined || strVal === "") {
      // Checkbox unchecked → false; everything else → omit
      if (tn === "ZodBoolean") result[key] = false;
      continue;
    }

    if (isDateUnion) {
      result[key] = new Date(strVal);
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

/** Resolve the innermost Zod type name (unwrapping Optional/Nullable/Default/Effects) */
function resolveTypeName(schema: z.ZodType): string {
  let s: z.ZodType = schema;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = getTypeName(s);
    if (tn === "ZodOptional" || tn === "ZodNullable" || tn === "ZodDefault") {
      s = getInnerType(s)!;
    } else if (
      tn === "ZodEffects" ||
      tn === "ZodPipe" ||
      tn === "ZodTransform"
    ) {
      const effectInner = getEffectInnerType(s);
      if (!effectInner) return tn;
      s = effectInner;
    } else {
      return tn;
    }
  }
}

/** Resolve the innermost Zod schema (unwrapping Optional/Nullable/Default/Effects) */
function resolveInnerSchema(schema: z.ZodType): z.ZodType {
  let s: z.ZodType = schema;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = getTypeName(s);
    if (tn === "ZodOptional" || tn === "ZodNullable" || tn === "ZodDefault") {
      s = getInnerType(s)!;
    } else if (
      tn === "ZodEffects" ||
      tn === "ZodPipe" ||
      tn === "ZodTransform"
    ) {
      const effectInner = getEffectInnerType(s);
      if (!effectInner) return s;
      s = effectInner;
    } else {
      return s;
    }
  }
}

/** True if the schema is wrapped in ZodOptional or ZodNullable (recursively). */
function isFieldNullable(schema: z.ZodType): boolean {
  let s: z.ZodType = schema;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = getTypeName(s);
    if (tn === "ZodOptional" || tn === "ZodNullable") return true;
    if (tn === "ZodDefault") {
      s = getInnerType(s)!;
      continue;
    }
    return false;
  }
}

/** Extract enum values from a (possibly wrapped) ZodEnum / ZodNativeEnum / ZodLiteral. Returns undefined if not an enum. */
function extractEnumValues(schema: z.ZodType): readonly string[] | undefined {
  const inner = resolveInnerSchema(schema);
  const tn = getTypeName(inner);
  if (tn === "ZodEnum") {
    const v = getEnumValues(inner);
    return v.length > 0 ? v : undefined;
  }
  if (tn === "ZodNativeEnum") {
    const obj = getNativeEnumValues(inner);
    const vals = Object.values(obj).filter(
      (v) => typeof v === "string",
    ) as string[];
    return vals.length > 0 ? vals : undefined;
  }
  if (tn === "ZodLiteral") {
    const v = getLiteralValue(inner);
    return typeof v === "string" ? [v] : undefined;
  }
  return undefined;
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

    // Unwrap Optional/Nullable/Default/Effects to check inner type
    const innerSchema = resolveInnerSchema(schema.shape[key] as z.ZodType);
    const innerTn = getTypeName(innerSchema);

    let isObjectLike = innerTn === "ZodObject";
    let objectSchema: z.ZodType = innerSchema;
    let isDateUnion = false;

    if (innerTn === "ZodUnion") {
      const options = getUnionOptions(innerSchema);
      if (options.some((opt) => getTypeName(opt) === "ZodDate")) {
        isDateUnion = true;
      }
      const geoOpt = options.find((opt) => {
        if (getTypeName(opt) === "ZodObject") {
          const s = getShape(opt);
          return "latitude" in s && "longitude" in s;
        }
        return false;
      });
      if (geoOpt) {
        isObjectLike = true;
        objectSchema = geoOpt;
      }
    }

    if (
      isObjectLike &&
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      // Don't mistake a raw Timestamp object { _seconds } for a general nested object,
      // it should fall through to the Date/Timestamp handling below.
      !("_seconds" in val) &&
      typeof (val as any).toDate !== "function"
    ) {
      // Recursively flatten nested object fields with dot-notation
      const nested = prefillFromDoc(
        val as Record<string, unknown>,
        objectSchema as z.ZodObject<any>,
        fullKey,
      );
      Object.assign(result, nested);
    } else if (innerTn === "ZodDate" || isDateUnion) {
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
    "in",
    "not-in",
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
  const NULL_SENTINEL = "__null__";
  const coerce = (v: string): unknown => {
    if (v === NULL_SENTINEL) return null;
    if (v === "true") return true;
    if (v === "false") return false;
    if (v !== "" && !isNaN(Number(v))) return Number(v);
    return v;
  };
  return filters.map((f) => {
    if (f.op === "array-contains-any" || f.op === "in" || f.op === "not-in") {
      // CSV list → array, each element coerced (drop empty / null sentinels —
      // Firestore rejects null inside `in`/`not-in`).
      const arr = f.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "" && s !== NULL_SENTINEL)
        .map((s) => coerce(s));
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
      result.push({
        name: fullName,
        zodType,
        nullable: isFieldNullable(field),
        enumValues: extractEnumValues(field),
      });
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
 * @see {@link import("../utils/link-base").getLinkBase}
 */
function getLinkBase(
  req: AnyReq,
  staticBasePath: string,
  region?: string,
): string {
  return getLinkBaseShared(req, staticBasePath, region);
}

export function createAdminHandlers(
  registry: RepoRegistry,
  basePath: string,
  region?: string,
) {
  // ── Dashboard ─────────────────────────────────────────────────────────────
  const handleDashboard = (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): void => {
    const lb = getLinkBase(req, basePath, region);
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
    let sortState = sortField ? { field: sortField, dir: sortDir } : undefined;

    // Rows per page (query ?ps= overrides config, capped at 200)
    const psRaw = parseInt(query["ps"] ?? "");
    const currentPageSize =
      Number.isFinite(psRaw) && psRaw > 0 ? Math.min(psRaw, 200) : pageSize;

    const allColumns = entry.listColumns ?? Object.keys(entry.schema.shape);
    const docKey = entry.documentKey ?? "docId";
    const columns = [docKey, ...allColumns.filter((c: string) => c !== docKey)];
    // Whitelist the sort field against listColumns ∪ docKey (fail-closed, #04):
    // an unknown `?ob=` is dropped rather than passed straight into the
    // Firestore `orderBy`, preventing schema probing, FAILED_PRECONDITION
    // crashes on arbitrary fields and unbounded query cost.
    if (sortState) {
      const orderableColumns = new Set<string>([docKey, ...allColumns]);
      if (!orderableColumns.has(sortState.field)) sortState = undefined;
    }
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
            nullable: resolved ? isFieldNullable(resolved) : false,
            enumValues: resolved ? extractEnumValues(resolved) : undefined,
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
      cursorSnapshot = await rehydrateAdminCursor(entry, cursorStr);
    }

    const [result, totalCount] = await Promise.all([
      entry.repo.query
        .paginate({
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
        })
        .catch(
          (err: unknown) =>
            ({
              queryError: toQueryError(err, {
                ref: entry.repo.ref,
                path: entry.path,
                isGroup: !!entry.isGroup,
                filters: activeFilters,
                sort: sortState,
              }),
            }) as const,
        ),
      entry.repo.aggregate
        .count(
          (whereFilters.length > 0
            ? { where: whereFilters as any }
            : {}) as any,
        )
        .catch(() => undefined as number | undefined),
    ]);

    // Discriminate between success and error results
    const isError = "queryError" in result;
    const docs = isError ? [] : (result.data as Record<string, unknown>[]);
    const nextCursorId = isError ? "" : (result.nextCursor?.ref?.path ?? result.nextCursor?.id ?? "");
    const prevCursorId = isError ? "" : (result.prevCursor?.ref?.path ?? result.prevCursor?.id ?? "");
    const queryError = isError ? result.queryError : undefined;
    const lb = getLinkBase(req, basePath, region);

    let flashObj:
      | { type: "success" | "error" | "warning"; message: string }
      | undefined;
    const flashQ = query["flash"];
    if (flashQ === "created")
      flashObj = { type: "success", message: "Document created successfully." };
    else if (flashQ === "updated")
      flashObj = { type: "success", message: "Document updated successfully." };
    else if (flashQ === "deleted")
      flashObj = { type: "success", message: "Document deleted successfully." };
    else if (flashQ === "backfilled")
      flashObj = {
        type: "success",
        message: "Repository backfilled successfully.",
      };

    sendHtml(
      res,
      renderList(
        entry.name,
        docs,
        columns,
        lb,
        {
          hasPrev: isError ? false : result.hasPrevPage,
          hasNext: isError ? false : result.hasNextPage,
          prevCursor: prevCursorId,
          nextCursor: nextCursorId,
        },
        flashObj,
        columnMeta,
        activeFilters,
        entry.allowDelete ?? false,
        entry.relationalMeta,
        sortState,
        currentPageSize,
        queryError,
        entry.isGroup,
        totalCount,
        entry.mutableFields,
        entry.schema,
        entry.historyEnabled,
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

    const lb = getLinkBase(req, basePath, region);
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

    const lb = getLinkBase(req, basePath, region);
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

    const lb = getLinkBase(req, basePath, region);

    let doc: Record<string, unknown> | null = null;
    try {
      doc = await fetchDocById(entry, docId);
    } catch (err) {
      const flash = flashFromDocFetchError(entry, docId, err);
      const status = isMissingIndexError(err) ? 424 : 500;
      sendHtml(
        res,
        renderPage("", {
          title: `Edit ${entry.name} / ${docId}`,
          basePath: lb,
          breadcrumb: [
            { label: "Repositories", href: lb },
            { label: entry.name, href: `${lb}/${entry.name}` },
            { label: `Edit ${docId}` },
          ],
          flash,
        }),
        status,
      );
      return;
    }

    if (!doc) {
      sendHtml(res, "Document not found", 404);
      return;
    }

    const prefilled = prefillFromDoc(doc, entry.schema);
    const mutableSchema = getMutableSchema(entry.schema, entry.mutableFields);
    const fields = applyPrefill(zodToFields(mutableSchema), prefilled);

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
    const lb = getLinkBase(req, basePath, region);
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
      const flash = isMissingIndexError(err)
        ? flashFromDocFetchError(entry, docId, err)
        : {
            type: "error" as const,
            message: `Save error: ${(err as Error).message}`,
          };
      const status = isMissingIndexError(err) ? 424 : 500;
      sendHtml(
        res,
        renderFormPage(entry.name, formHtml, "edit", docId, lb, flash),
        status,
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
    const lb = getLinkBase(req, basePath, region);
    try {
      // Fetch document to extract path args for subcollection repos
      const doc = await fetchDocById(entry, docId);
      const pathArgs = (doc && extractPathArgs(doc, entry.pathKey)) ?? [docId];
      await entry.repo.delete(...pathArgs);
      redirect(res, `${lb}/${entry.name}?flash=deleted`);
    } catch (err) {
      const flash = isMissingIndexError(err)
        ? flashFromDocFetchError(entry, docId, err)
        : {
            type: "error" as const,
            message: `Delete error: ${(err as Error).message}`,
          };
      const status = isMissingIndexError(err) ? 424 : 500;
      sendHtml(
        res,
        renderPage("", {
          title: `Delete ${entry.name} / ${docId}`,
          basePath: lb,
          breadcrumb: [
            { label: "Repositories", href: lb },
            { label: entry.name, href: `${lb}/${entry.name}` },
            { label: `Delete ${docId}` },
          ],
          flash,
        }),
        status,
      );
    }
  };

  // ── Relation right-panel preview (HTML fragment, no shell) ───────────────
  const handlePanel = async (
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
    const lb = getLinkBase(req, basePath, region);
    const query = (req as any).query as Record<string, string> | undefined;
    const type = query?.["type"] === "many" ? "many" : "one";
    const ps = Math.max(1, Math.min(100, Number(query?.["ps"] ?? 25) || 25));
    const allColumns = entry.listColumns ?? Object.keys(getShape(entry.schema));

    // Lazy import the panel components — they're only used by this route.
    const { PanelOne, PanelMany } = await import("./components/right-panel");
    const { renderToString } = await import("hono/jsx/dom/server");

    if (type === "one") {
      const id = String(query?.["id"] ?? "");
      if (!id) {
        sendHtml(
          res,
          "<div class='p-6 text-error'>Missing id parameter.</div>",
          400,
        );
        return;
      }
      try {
        const doc = await fetchDocById(entry, id);
        const html = renderToString(
          PanelOne({
            doc,
            repoName: entry.name,
            basePath: lb,
            schema: entry.schema,
            columns: allColumns,
          }) as any,
        );
        sendHtml(res, html);
      } catch (err) {
        sendHtml(
          res,
          `<div class='p-6 text-error text-sm'>Error: ${(err as Error).message}</div>`,
          500,
        );
      }
      return;
    }

    // many
    const fk = String(query?.["fk"] ?? "");
    const fv = String(query?.["fv"] ?? "");
    if (!fk || !fv) {
      sendHtml(
        res,
        "<div class='p-6 text-error'>Missing fk/fv parameters.</div>",
        400,
      );
      return;
    }
    const cursorStr = query?.["cursor"] ?? "";
    const dir = query?.["dir"] === "prev" ? "prev" : "next";
    let cursorSnapshot:
      | import("firebase-admin/firestore").DocumentSnapshot
      | undefined;
    if (cursorStr) {
      cursorSnapshot = await rehydrateAdminCursor(entry, cursorStr);
    }
    try {
      const result = await entry.repo.query.paginate({
        pageSize: ps,
        cursor: cursorSnapshot,
        ...{ direction: dir },
        ...{ where: [[fk, "==", coerceFilterValue(fv)]] },
      } as any);
      const html = renderToString(
        PanelMany({
          docs: result.data as Record<string, unknown>[],
          repoName: entry.name,
          basePath: lb,
          fk,
          fv,
          columns: allColumns,
          schema: entry.schema,
          pagination: {
            hasPrev: result.hasPrevPage,
            hasNext: result.hasNextPage,
            prevCursor: result.prevCursor?.ref?.path ?? result.prevCursor?.id ?? "",
            nextCursor: result.nextCursor?.ref?.path ?? result.nextCursor?.id ?? "",
            pageSize: ps,
          },
        }) as any,
      );
      sendHtml(res, html);
    } catch (err) {
      sendHtml(
        res,
        `<div class='p-6 text-error text-sm'>Error: ${(err as Error).message}</div>`,
        500,
      );
    }
  };

  // ── Bulk operations ──────────────────────────────────────────────────────
  const handleBulkBackfill = async (
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
    const lb = getLinkBase(req, basePath, region);
    try {
      await entry.repo.system.backfillKeys();
      // Since it's a form submit, we just redirect back to the list
      redirect(res, `${lb}/${entry.name}?flash=backfilled`);
    } catch (err) {
      // Very basic error handling
      sendHtml(
        res,
        `<div class="p-6 text-error">Backfill failed: ${(err as Error).message}</div>`,
        500,
      );
    }
  };

  /** Build DocumentReferences for a list of docIds, handling subcollections via fetchDocById. */
  const resolveRefs = async (
    entry: AdminRepoEntry,
    ids: string[],
  ): Promise<import("firebase-admin/firestore").DocumentReference[]> => {
    const refs: import("firebase-admin/firestore").DocumentReference[] = [];
    for (const id of ids) {
      let pathArgs: string[] | undefined;
      if (entry.isGroup || entry.parentKeys?.length) {
        const doc = await fetchDocById(entry, id);
        pathArgs = doc ? extractPathArgs(doc, entry.pathKey) : undefined;
      }
      if (!pathArgs) pathArgs = [id];
      try {
        const ref = (entry.repo as any).documentRef(...pathArgs);
        if (ref) refs.push(ref);
      } catch {
        /* ignore */
      }
    }
    return refs;
  };

  /** Resolve all docIds matching a set of filters by streaming the query in pages. */
  const resolveAllIds = async (
    entry: AdminRepoEntry,
    filters: FilterState[],
  ): Promise<string[]> => {
    const where = filtersToWhere(filters);
    const docKey = entry.documentKey ?? "docId";
    const ids: string[] = [];
    let cursor: import("firebase-admin/firestore").DocumentSnapshot | undefined;
    // Stream in pages of 500
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page: any = await entry.repo.query.paginate({
        pageSize: 500,
        cursor,
        ...{ direction: "next" },
        ...(where.length > 0 ? { where } : {}),
      } as any);
      for (const d of page.data as Record<string, unknown>[]) {
        const id = String(d[docKey] ?? d["id"] ?? "");
        if (id) ids.push(id);
      }
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return ids;
  };

  const handleBulkDelete = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    if (!repoName) {
      sendJson(res, { error: "Bad request" }, 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendJson(res, { error: "Repository not found" }, 404);
      return;
    }
    if (!entry.allowDelete) {
      sendJson(
        res,
        { error: "Delete is not allowed for this repository" },
        403,
      );
      return;
    }
    const body = ((req as any).body ?? {}) as {
      ids?: unknown;
      selectAll?: unknown;
      filters?: unknown;
    };
    try {
      const ids = await collectTargetIds(entry, body);
      if (ids.length === 0) {
        sendJson(res, { deleted: 0 });
        return;
      }
      const refs = await resolveRefs(entry, ids);
      // Chunk to 500 per Firestore batched-write limit
      for (let i = 0; i < refs.length; i += 500) {
        await entry.repo.bulk.delete(refs.slice(i, i + 500));
      }
      sendJson(res, { deleted: refs.length });
    } catch (err) {
      sendJson(res, { error: (err as Error).message }, 500);
    }
  };

  const handleBulkUpdate = async (
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
  ): Promise<void> => {
    const repoName = req.params["repoName"];
    if (!repoName) {
      sendJson(res, { error: "Bad request" }, 400);
      return;
    }
    const entry = registry[repoName];
    if (!entry) {
      sendJson(res, { error: "Repository not found" }, 404);
      return;
    }
    const body = ((req as any).body ?? {}) as {
      ids?: unknown;
      selectAll?: unknown;
      filters?: unknown;
      field?: unknown;
      formPayload?: Record<string, string | string[]>;
    };
    const field = String(body.field ?? "");
    if (!field) {
      sendJson(res, { error: "Missing 'field'" }, 400);
      return;
    }
    // SECURITY: Strict allow-list of fields
    if (!entry.mutableFields || !entry.mutableFields.includes(field)) {
      sendJson(res, { error: `Field '${field}' is not bulk-updatable` }, 403);
      return;
    }
    // Parse value through the field's Zod schema for validation/coercion
    const fieldSchema = (entry.schema as any).shape?.[field] as
      | z.ZodType
      | undefined;
    let parsedValue: unknown;
    if (fieldSchema) {
      // Use parseFormBody to properly extract objects (like GeoPoint) and dates from url-encoded-like payloads
      const dummySchema =
        typeof entry.schema === "object" &&
        entry.schema &&
        "constructor" in entry.schema &&
        (entry.schema.constructor as any).name.includes("Zod")
          ? (entry.schema as z.ZodObject<any>).pick({ [field]: true })
          : undefined;

      if (!dummySchema) {
        sendJson(res, { error: "Invalid schema structure" }, 500);
        return;
      }

      const parsedMap = parseFormBody(
        (body.formPayload ?? {}) as Record<
          string,
          string | string[] | undefined
        >,
        dummySchema as z.ZodObject<any>,
      );
      parsedValue = parsedMap[field];

      const parsed = fieldSchema.safeParse(parsedValue);
      if (!parsed.success) {
        sendJson(
          res,
          { error: `Invalid value for '${field}': ${parsed.error.message}` },
          400,
        );
        return;
      }
      parsedValue = parsed.data;
    }
    try {
      const ids = await collectTargetIds(entry, body);
      if (ids.length === 0) {
        sendJson(res, { updated: 0 });
        return;
      }
      const refs = await resolveRefs(entry, ids);
      const items = refs.map((docRef) => ({
        docRef,
        data: { [field]: parsedValue } as any,
      }));
      for (let i = 0; i < items.length; i += 500) {
        await entry.repo.bulk.update(items.slice(i, i + 500));
      }
      sendJson(res, { updated: items.length });
    } catch (err) {
      sendJson(res, { error: (err as Error).message }, 500);
    }
  };

  /** Shared logic: extract target IDs from a request body (`ids[]` OR `selectAll + filters`). */
  async function collectTargetIds(
    entry: AdminRepoEntry,
    body: { ids?: unknown; selectAll?: unknown; filters?: unknown },
  ): Promise<string[]> {
    if (body.selectAll) {
      const filters = sanitizeFilters(body.filters, entry);
      return await resolveAllIds(entry, filters);
    }
    if (Array.isArray(body.ids)) {
      return body.ids.filter((x): x is string => typeof x === "string" && !!x);
    }
    return [];
  }

  function sanitizeFilters(raw: unknown, entry: AdminRepoEntry): FilterState[] {
    if (!Array.isArray(raw)) return [];
    const validFields = new Set(
      (entry.filterableFields ?? Object.keys(getShape(entry.schema))).map((s) =>
        String(s),
      ),
    );
    const validOps = new Set([
      "==",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
      "in",
      "not-in",
      "array-contains",
      "array-contains-any",
    ]);
    const out: FilterState[] = [];
    for (const f of raw) {
      if (
        f &&
        typeof f === "object" &&
        typeof (f as any).field === "string" &&
        validFields.has((f as any).field) &&
        typeof (f as any).value === "string" &&
        validOps.has(String((f as any).op))
      ) {
        out.push({
          field: (f as any).field,
          op: (f as any).op,
          value: (f as any).value,
        });
      }
    }
    return out;
  }

  // ── History list ──────────────────────────────────────────────────────────
  const handleHistory = async (
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
    if (!entry.historyEnabled || !(entry.repo as any).history) {
      sendHtml(res, "History not enabled for this repository", 404);
      return;
    }

    const lb = getLinkBase(req, basePath, region);
    const subcollection = entry.historySubcollection ?? "history";

    let pathArgs: string[] = [docId];
    try {
      const doc = await fetchDocById(entry, docId);
      const extracted = doc ? extractPathArgs(doc, entry.pathKey) : undefined;
      if (extracted && extracted.length > 0) pathArgs = extracted;
    } catch {
      // best-effort: fall back to [docId]
    }

    const limitRaw = parseInt(String((req.query as any)?.limit ?? ""));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

    let entries: any[] = [];
    let errorMsg: string | undefined;
    try {
      entries = await (entry.repo as any).history.list(...pathArgs, { limit });
    } catch (err) {
      errorMsg = (err as Error).message;
    }

    const escape = (s: unknown): string =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const fmtVal = (v: unknown): string => {
      if (v === undefined) return '<span class="opacity-40">undefined</span>';
      if (v === null) return '<span class="opacity-40">null</span>';
      if (typeof v === "object") {
        try {
          return `<code class="text-xs">${escape(JSON.stringify(v))}</code>`;
        } catch {
          return escape(String(v));
        }
      }
      return escape(String(v));
    };

    const fmtTs = (ts: any): string => {
      if (!ts) return "";
      if (typeof ts.toDate === "function") return ts.toDate().toISOString();
      if (ts instanceof Date) return ts.toISOString();
      return escape(String(ts));
    };

    const opBadge = (op: string): string => {
      const cls =
        op === "create"
          ? "badge-success"
          : op === "delete"
            ? "badge-error"
            : "badge-info";
      return `<span class="badge badge-sm ${cls}">${escape(op)}</span>`;
    };

    let body = "";
    body += `<div class="flex items-center justify-between mb-4">`;
    body += `<a href="${lb}/${entry.name}/${encodeURIComponent(docId)}/edit" class="btn btn-sm btn-outline">← Back to edit</a>`;
    body += `<a href="${lb}/${entry.name}" class="btn btn-sm btn-outline">← Back to list</a>`;
    body += `</div>`;

    body += `<p class="text-sm text-base-content/60 mb-4">Subcollection: <code>${escape(subcollection)}</code> · Showing up to ${limit} entries.</p>`;

    if (errorMsg) {
      body += `<div class="alert alert-error mb-4">${escape(errorMsg)}</div>`;
    } else if (entries.length === 0) {
      body += `<div class="alert">No history entries found.</div>`;
    } else {
      body += `<div class="overflow-x-auto"><table class="table table-zebra table-sm">`;
      body += `<thead><tr><th>When</th><th>Op</th><th>User</th><th>Reason / Comment</th><th>Changes</th></tr></thead><tbody>`;
      for (const e of entries) {
        const meta = e.meta ?? {};
        const reasonComment = [meta.reason, meta.comment]
          .filter((x: unknown) => x != null && x !== "")
          .map((x: unknown) => escape(String(x)))
          .join(" — ");
        let changesHtml = "";
        const changeKeys = Object.keys(e.changes ?? {});
        if (changeKeys.length === 0) {
          changesHtml = '<span class="opacity-40">—</span>';
        } else {
          changesHtml =
            '<ul class="space-y-1">' +
            changeKeys
              .map((k) => {
                const c = e.changes[k];
                return `<li><strong>${escape(k)}</strong>: ${fmtVal(c.oldValue)} → ${fmtVal(c.newValue)}</li>`;
              })
              .join("") +
            "</ul>";
        }
        body += `<tr>`;
        body += `<td class="whitespace-nowrap text-xs font-mono">${escape(fmtTs(e.historySetAt))}</td>`;
        body += `<td>${opBadge(e.operation ?? "update")}</td>`;
        body += `<td class="text-xs">${escape(meta.userEmail ?? meta.userId ?? "")}</td>`;
        body += `<td class="text-xs">${reasonComment}</td>`;
        body += `<td>${changesHtml}</td>`;
        body += `</tr>`;
      }
      body += `</tbody></table></div>`;
    }

    sendHtml(
      res,
      renderPage(body, {
        title: `History — ${entry.name} / ${docId}`,
        basePath: lb,
        breadcrumb: [
          { label: "Repositories", href: lb },
          { label: entry.name, href: `${lb}/${entry.name}` },
          { label: `History ${docId}` },
        ],
      }),
    );
  };

  return {
    handleDashboard,
    handleList,
    handleCreateForm,
    handleCreateSubmit,
    handleEditForm,
    handleEditSubmit,
    handleDelete,
    handlePanel,
    handleBulkDelete,
    handleBulkUpdate,
    handleBulkBackfill,
    handleHistory,
  };
}

function sendJson(res: AnyRes, payload: unknown, status = 200): void {
  res
    .status(status)
    .set("Content-Type", "application/json; charset=utf-8")
    .send(JSON.stringify(payload));
}

/** Coerce a string filter value to the most likely runtime type for a Firestore where clause. */
function coerceFilterValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !isNaN(Number(v))) return Number(v);
  return v;
}
