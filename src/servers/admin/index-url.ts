/**
 * Generates a Firebase Console URL to create a composite index OR a
 * single-field index exemption.
 *
 * When Firestore throws FAILED_PRECONDITION (code 9) for missing indexes,
 * the error message sometimes includes a creation link (regular collections)
 * but often does NOT include it (collection groups). This utility builds the
 * link from the query context so the admin UI can always present it.
 *
 * Two URL shapes are produced depending on the query:
 *
 * - **Composite index** (≥ 2 indexed fields, or any COLLECTION-scope multi-field
 *   query). Encoded as a JSON `create_composite=` parameter under
 *   `/v1/r/project/{p}/firestore/indexes`.
 *
 * - **Single-field exemption** (exactly one indexed field on a COLLECTION_GROUP
 *   query — Firestore disables single-field collection-group indexes by
 *   default and requires an explicit exemption). Encoded as a base64
 *   protobuf `create_exemption=` parameter under
 *   `/project/{p}/firestore/databases/-default-/indexes/automatic`.
 */

import type {
  FilterState,
  QueryError,
  SortState,
  WhereOp,
} from "./components/types";

// ── Types ────────────────────────────────────────────────────────────────────

interface IndexField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RANGE_OPS = new Set<WhereOp>(["<", "<=", ">", ">=", "!="]);
const ARRAY_OPS = new Set<WhereOp>(["array-contains", "array-contains-any"]);

function toIndexOrder(dir?: "asc" | "desc"): "ASCENDING" | "DESCENDING" {
  return dir === "desc" ? "DESCENDING" : "ASCENDING";
}

/**
 * Extract the collection ID (last path segment) from a Firestore path.
 * e.g. "posts/{postId}/comments" → "comments"
 */
export function collectionIdFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Build a Firebase Console URL that pre-fills the composite-index creation form.
 *
 * @param projectId  - GCP project ID (e.g. "firestore-repo-services")
 * @param collectionId - Firestore collection ID (e.g. "posts", "comments")
 * @param isGroup    - Whether this is a collection group query
 * @param filters    - Active filter states from the admin UI
 * @param sort       - Active sort state (optional)
 * @returns          - Full HTTPS URL to the Firebase Console index wizard
 */
export function buildIndexUrl(
  projectId: string,
  collectionId: string,
  isGroup: boolean,
  filters: FilterState[],
  sort?: SortState,
): string {
  const fields: IndexField[] = [];
  const seen = new Set<string>();

  // 1. Equality filters first (order doesn't matter for equality)
  for (const f of filters) {
    if (f.op === "==" || f.op === "in" || f.op === "not-in") {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      fields.push({ fieldPath: f.field, order: "ASCENDING" });
    }
  }

  // 2. Array operators
  for (const f of filters) {
    if (ARRAY_OPS.has(f.op)) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      fields.push({ fieldPath: f.field, arrayConfig: "CONTAINS" });
    }
  }

  // 3. Range / inequality filters
  for (const f of filters) {
    if (RANGE_OPS.has(f.op)) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      // Use the sort direction if the range field matches the orderBy field
      const dir =
        sort?.field === f.field ? toIndexOrder(sort.dir) : "ASCENDING";
      fields.push({ fieldPath: f.field, order: dir });
    }
  }

  // 4. OrderBy fields not already covered by filters
  if (sort && !seen.has(sort.field)) {
    fields.push({ fieldPath: sort.field, order: toIndexOrder(sort.dir) });
  }

  // ── Single-field collection-group exemption ──────────────────────────────
  // Firestore disables single-field collection-group indexes by default; you
  // must create an explicit "field exemption". The Firebase Console wizard
  // for that uses a totally different URL (`create_exemption=`) with its own
  // protobuf shape — see buildExemptionUrl below.
  if (fields.length === 1 && isGroup) {
    return buildExemptionUrl(projectId, collectionId, fields[0]!);
  }

  // ── Composite index ──────────────────────────────────────────────────────
  // Firebase Console encodes composite indexes as a base64 protobuf payload
  // under `create_composite=`. Every composite index implicitly ends with
  // `__name__` as a tie-breaker, so we always append it (matches what the
  // Console itself produces).
  const lastDir =
    sort && fields.some((f) => f.fieldPath === sort.field)
      ? toIndexOrder(sort.dir)
      : "ASCENDING";
  fields.push({ fieldPath: "__name__", order: lastDir });

  return buildCompositeUrl(projectId, collectionId, isGroup, fields);
}

/**
 * Build a Firebase Console URL that pre-fills the composite index creation
 * form for either a regular collection or a collection-group query.
 *
 * The URL uses a base64-encoded protobuf payload (the same shape the Console
 * itself produces when you click "Add index" in the UI). Schema:
 *
 *   message CompositeIndex {
 *     string resource_path = 1;        // projects/.../collectionGroups/{cg}/indexes/_
 *     int32  query_scope    = 2;       // 1 = COLLECTION, 2 = COLLECTION_GROUP
 *     repeated IndexField fields = 3;
 *   }
 */
export function buildCompositeUrl(
  projectId: string,
  collectionId: string,
  isGroup: boolean,
  fields: IndexField[],
  databaseId: string = "(default)",
): string {
  const resource = `projects/${projectId}/databases/${databaseId}/collectionGroups/${collectionId}/indexes/_`;

  const payload: number[] = [
    ...pbString(1, resource),
    ...pbInt(2, isGroup ? 2 : 1),
  ];
  for (const f of fields) {
    payload.push(...pbMessage(3, encodeIndexField(f)));
  }

  const urlDbId = databaseId === "(default)" ? "-default-" : databaseId;
  const encoded = encodeURIComponent(toBase64(payload));
  return `https://console.firebase.google.com/project/${projectId}/firestore/databases/${urlDbId}/indexes?create_composite=${encoded}`;
}

/**
 * Try to extract an index-creation URL from a Firestore error message.
 * Returns `undefined` if no URL is found.
 */
export function extractIndexUrl(message: string): string | undefined {
  const match = message.match(
    /https:\/\/console\.firebase\.google\.com[^\s)"]*/,
  );
  return match?.[0];
}

// ── Single-field exemption URL (collection-group) ────────────────────────────

/**
 * Minimal protobuf encoder for the field-exemption payload used by the
 * Firebase Console URL `?create_exemption=…`.
 *
 * Wire format (subset):
 *   tag = (field_number << 3) | wire_type
 *   wire types: 0 = varint, 2 = length-delimited
 *
 * Schema we encode (reverse-engineered from real Firebase Console URLs):
 *   message FieldExemption {
 *     string resource_path = 1;        // projects/.../fields/{field}
 *     int32  query_scope    = 2;       // 1 = COLLECTION, 2 = COLLECTION_GROUP
 *     IndexConfig index    = 3;
 *   }
 *   message IndexConfig {
 *     string field_path  = 1;
 *     int32  order       = 2;          // 1 = ASCENDING, 2 = DESCENDING
 *     int32  array_config = 3;         // 1 = CONTAINS  (mutually exclusive with order)
 *   }
 */
function pbVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

function pbTag(fieldNumber: number, wireType: 0 | 2): number {
  return (fieldNumber << 3) | wireType;
}

function pbString(fieldNumber: number, value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [pbTag(fieldNumber, 2), ...pbVarint(bytes.length), ...bytes];
}

function pbInt(fieldNumber: number, value: number): number[] {
  return [pbTag(fieldNumber, 0), ...pbVarint(value)];
}

function pbMessage(fieldNumber: number, payload: number[]): number[] {
  return [pbTag(fieldNumber, 2), ...pbVarint(payload.length), ...payload];
}

/** Encode an IndexField submessage: { field_path:1, order:2 OR array_config:3 } */
function encodeIndexField(f: IndexField): number[] {
  const out: number[] = [...pbString(1, f.fieldPath)];
  if (f.arrayConfig === "CONTAINS") {
    out.push(...pbInt(3, 1));
  } else {
    out.push(...pbInt(2, f.order === "DESCENDING" ? 2 : 1));
  }
  return out;
}

function toBase64(bytes: number[]): string {
  // Standard base64 (no padding) — matches what Firebase Console produces.
  // Use Buffer when available (Node), otherwise fall back to btoa.
  const bin = String.fromCharCode(...bytes);
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(bytes).toString("base64");
  } else if (typeof btoa !== "undefined") {
    b64 = btoa(bin);
  } else {
    throw new Error("No base64 encoder available");
  }
  return b64.replace(/=+$/, "");
}

/**
 * Build a Firebase Console URL that pre-fills the single-field index
 * exemption form for a collection-group query.
 */
export function buildExemptionUrl(
  projectId: string,
  collectionId: string,
  field: IndexField,
  databaseId: string = "(default)",
): string {
  const resource = `projects/${projectId}/databases/${databaseId}/collectionGroups/${collectionId}/fields/${field.fieldPath}`;

  const payload: number[] = [
    ...pbString(1, resource),
    ...pbInt(2, 2), // COLLECTION_GROUP
    ...pbMessage(3, encodeIndexField(field)),
  ];

  // Database ID for the URL path: "(default)" → "-default-",
  // any other ID is used as-is (Firebase Console uses the bare ID).
  const urlDbId = databaseId === "(default)" ? "-default-" : databaseId;

  // create_exemption is base64 (URL-safe characters only — `+` and `/` are
  // valid in query string values per RFC, and Firebase accepts them, but we
  // URL-encode just to be safe).
  const encoded = encodeURIComponent(toBase64(payload));
  return `https://console.firebase.google.com/project/${projectId}/firestore/databases/${urlDbId}/indexes/automatic?create_exemption=${encoded}`;
}

// ── Project ID extraction ────────────────────────────────────────────────────

/**
 * Robustly extract the GCP project ID from a Firestore reference.
 * Falls back through several known locations across firebase-admin versions
 * and finally to standard environment variables.
 */
export function extractProjectId(ref: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = ref as any;
  const candidates: unknown[] = [
    r?.firestore?.projectId,
    r?.firestore?.app?.options?.projectId,
    r?.firestore?._settings?.projectId,
    r?.firestore?.databaseId?.projectId,
    r?._firestore?.projectId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  const env =
    process.env["GCLOUD_PROJECT"] ||
    process.env["GOOGLE_CLOUD_PROJECT"] ||
    process.env["FIREBASE_PROJECT_ID"];
  return env || undefined;
}

// ── Centralized error → QueryError conversion ────────────────────────────────

/**
 * Context required to build a fallback index URL when Firestore does not
 * include one in its error (typical for collection-group queries).
 */
export interface QueryErrorContext {
  /** Repository ref (CollectionReference / Query) used to extract project id */
  ref: unknown;
  /** Firestore collection path of the repo (e.g. "posts/{postId}/comments") */
  path: string;
  /** Whether the repo is a collection-group */
  isGroup: boolean;
  /** Active where filters at the time of the failed query */
  filters: FilterState[];
  /** Active orderBy state at the time of the failed query (if any) */
  sort?: SortState;
}

/**
 * Detect whether an unknown error thrown by Firestore is a missing-index
 * (`FAILED_PRECONDITION` / code 9) error.
 */
export function isMissingIndexError(err: unknown): boolean {
  const fe = err as { code?: number; message?: string } | null | undefined;
  if (!fe) return false;
  if (fe.code === 9) return true;
  return typeof fe.message === "string"
    ? fe.message.includes("requires an index")
    : false;
}

/**
 * Convert a Firestore error into a typed `QueryError` with a guaranteed
 * `indexUrl` for missing-index cases (extracted from the message when
 * present, otherwise rebuilt from the query context — necessary for
 * collection-group queries where the SDK omits the link).
 *
 * Returns `null` when `err` is falsy.
 */
export function toQueryError(
  err: unknown,
  ctx: QueryErrorContext,
): QueryError {
  const fe = (err ?? {}) as { code?: number; message?: string };
  const isIndex = isMissingIndexError(err);

  let indexUrl: string | undefined;
  if (isIndex) {
    indexUrl = fe.message ? extractIndexUrl(fe.message) : undefined;
    if (!indexUrl) {
      const projectId = extractProjectId(ctx.ref);
      if (projectId) {
        const colId = collectionIdFromPath(ctx.path);
        indexUrl = buildIndexUrl(
          projectId,
          colId,
          ctx.isGroup,
          ctx.filters,
          ctx.sort,
        );
      }
    }
  }

  return {
    type: isIndex ? "index" : "error",
    message: isIndex
      ? "This query requires a composite index that does not exist yet."
      : (fe.message ?? "Query failed"),
    indexUrl,
  };
}
