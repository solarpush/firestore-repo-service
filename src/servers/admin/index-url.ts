/**
 * Generates a Firebase Console URL to create a composite index.
 *
 * When Firestore throws FAILED_PRECONDITION (code 9) for missing indexes,
 * the error message sometimes includes a creation link (regular collections)
 * but often does NOT include it (collection groups). This utility builds the
 * link from the query context so the admin UI can always present it.
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

interface IndexConfig {
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: IndexField[];
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

  const config: IndexConfig = {
    collectionGroup: collectionId,
    queryScope: isGroup ? "COLLECTION_GROUP" : "COLLECTION",
    fields,
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://console.firebase.google.com/v1/r/project/${projectId}/firestore/indexes?create_composite=${encoded}`;
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
