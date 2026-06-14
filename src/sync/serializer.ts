import type { RepoSyncConfig } from "./types";

/**
 * Convert a single Firestore value into a SQL-safe primitive.
 *
 * Complex types (arrays, GeoPoints, binary) become JSON strings.
 * Primitives pass through unchanged.
 * Objects are NOT stringified here — they are flattened by serializeDocument.
 */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  // Firestore Timestamp (duck-typed: has .toDate())
  if (
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).toDate === "function"
  ) {
    return ((value as { toDate(): Date }).toDate()).toISOString();
  }

  if (value instanceof Date) return value.toISOString();

  if (Buffer.isBuffer(value)) return value.toString("base64");

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  // Firestore GeoPoint (duck-typed: has latitude & longitude)
  if (
    typeof value === "object" &&
    "latitude" in (value as object) &&
    "longitude" in (value as object)
  ) {
    const geo = value as { latitude: number; longitude: number };
    return JSON.stringify({ lat: geo.latitude, lng: geo.longitude });
  }

  // Arrays → JSON (native JSON column in BigQuery)
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(serializeValue));
  }

  // string | number | boolean — pass through
  // Plain objects are handled by flattenObject in serializeDocument
  return value;
}

/**
 * Recursively flatten a nested object into a flat key-value map
 * using underscore-separated keys: `{ address: { street: "x" } }` → `{ address_street: "x" }`.
 * Arrays and non-plain-object values are serialized as leaves.
 *
 * Guards against pathological inputs that would otherwise crash the worker
 * (and trigger an infinite PubSub redelivery loop, see issue #11):
 * - **Cycles** (`obj.self = obj`) → emitted once as a `{ __cycle: true }` marker.
 * - **Excessive depth** → truncated past {@link MAX_FLATTEN_DEPTH}.
 * - **Excessive width** → stops emitting past {@link MAX_FLATTEN_KEYS}
 *   (BigQuery caps tables at 10k columns).
 */
const MAX_FLATTEN_DEPTH = 32;
const MAX_FLATTEN_KEYS = 5000;

function flattenObject(
  obj: Record<string, unknown>,
  prefix: string,
  result: Record<string, unknown>,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  if (depth > MAX_FLATTEN_DEPTH) {
    result[prefix || "_truncated"] = JSON.stringify({ __truncated: true });
    return;
  }
  if (seen.has(obj)) {
    result[prefix || "_cycle"] = JSON.stringify({ __cycle: true });
    return;
  }
  seen.add(obj);

  for (const [key, value] of Object.entries(obj)) {
    if (Object.keys(result).length >= MAX_FLATTEN_KEYS) break;
    const flatKey = prefix ? `${prefix}__${key}` : key;

    if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array) &&
      // Not a Firestore Timestamp
      typeof (value as Record<string, unknown>).toDate !== "function" &&
      // Not a GeoPoint
      !("latitude" in (value as object) && "longitude" in (value as object))
    ) {
      // Plain object → recurse
      flattenObject(
        value as Record<string, unknown>,
        flatKey,
        result,
        seen,
        depth + 1,
      );
    } else {
      result[flatKey] = serializeValue(value);
    }
  }

  // Allow the same object to appear in sibling branches (only direct
  // ancestors form a cycle), so drop it from the path on the way out.
  seen.delete(obj);
}

/**
 * Serialize a full Firestore document into a flat object of SQL-safe values.
 *
 * Nested objects are flattened into underscore-separated column names
 * (e.g. `address.street` → `address_street`). Arrays become JSON strings.
 * Applies optional field exclusions and column renames from `options`.
 */
export function serializeDocument(
  doc: Record<string, unknown>,
  options?: Pick<RepoSyncConfig, "exclude" | "columnMap">,
): Record<string, unknown> {
  const exclude = new Set(options?.exclude);
  const columnMap = options?.columnMap ?? {};

  // First flatten the document
  const flat: Record<string, unknown> = {};
  flattenObject(doc, "", flat);

  // Then apply excludes and column renames
  const result: Record<string, unknown> = {};
  for (const [flatKey, value] of Object.entries(flat)) {
    if (exclude.has(flatKey)) continue;
    // Also check top-level prefix for excludes (e.g. exclude "address" removes all address_* cols)
    const topLevel = flatKey.split("__")[0]!;
    if (topLevel !== flatKey && exclude.has(topLevel)) continue;
    const column =
      columnMap[flatKey] ??
      (flatKey.includes("__")
        ? columnMap[flatKey.split("__").pop()!]
        : undefined) ??
      flatKey;
    result[column] = value;
  }

  return result;
}
