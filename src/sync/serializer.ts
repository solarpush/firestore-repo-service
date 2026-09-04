import type { RepoSyncConfig } from "./types";

/**
 * Convert a single Firestore value into a SQL-safe primitive or JSON-serializable value.
 *
 * Complex types (arrays, GeoPoints, binary) become JSON strings in flat mode.
 * In non-flat mode (`stringifyArrays: false`), arrays and nested objects stay structured.
 * Primitives pass through unchanged.
 */
export function serializeValue(
  value: unknown,
  options?: { stringifyArrays?: boolean },
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
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
    if (options?.stringifyArrays === false) {
      return { lat: geo.latitude, lng: geo.longitude };
    }
    return JSON.stringify({ lat: geo.latitude, lng: geo.longitude });
  }

  // Arrays
  if (Array.isArray(value)) {
    const mapped = value.map((item) =>
      serializeValue(item, options, seen, depth + 1),
    );
    return options?.stringifyArrays === false ? mapped : JSON.stringify(mapped);
  }

  // Plain objects (when inside nested serialization)
  if (
    typeof value === "object" &&
    value !== null &&
    options?.stringifyArrays === false
  ) {
    return serializeNestedObject(
      value as Record<string, unknown>,
      new Set(),
      {},
      seen,
      depth + 1,
    );
  }

  // string | number | boolean — pass through
  // Plain objects in flat mode are handled by flattenObject in serializeDocument
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
 * Recursively serialize a nested object preserving object and array structures,
 * while serializing leaf values (Timestamps, Dates, Buffers, GeoPoints).
 */
function serializeNestedObject(
  obj: Record<string, unknown>,
  exclude: Set<string>,
  columnMap: Record<string, string>,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_FLATTEN_DEPTH) {
    return { __truncated: true };
  }
  if (seen.has(obj)) {
    return { __cycle: true };
  }
  seen.add(obj);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (exclude.has(key)) continue;
    const mappedKey = columnMap[key] ?? key;

    if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array) &&
      typeof (value as Record<string, unknown>).toDate !== "function" &&
      !("latitude" in (value as object) && "longitude" in (value as object))
    ) {
      result[mappedKey] = serializeNestedObject(
        value as Record<string, unknown>,
        new Set(),
        {},
        seen,
        depth + 1,
      );
    } else {
      result[mappedKey] = serializeValue(
        value,
        { stringifyArrays: false },
        seen,
        depth + 1,
      );
    }
  }

  seen.delete(obj);
  return result;
}

/**
 * Reconstructs nested objects from flat double-underscore keys (`address__city` → `address.city`)
 * and parses JSON-stringified arrays back into native arrays.
 */
export function unflattenDocument(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(doc)) {
    let value = rawValue;

    // If array or object was stringified into JSON (e.g. from a flat SQL sync worker event)
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        (trimmed.startsWith("{") && trimmed.endsWith("}"))
      ) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          // Keep as string if not valid JSON
        }
      }
    }

    if (key.startsWith("__") || !key.includes("__")) {
      result[key] = value;
      continue;
    }

    const parts = key.split("__").filter(Boolean);
    let current: any = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (
        !current[part] ||
        typeof current[part] !== "object" ||
        Array.isArray(current[part])
      ) {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]!] = value;
  }

  return result;
}

/**
 * Serialize a full Firestore document.
 *
 * When `flat` is `true` (default):
 * Nested objects are flattened into underscore-separated column names
 * (e.g. `address.street` → `address_street`). Arrays become JSON strings.
 *
 * When `flat` is `false`:
 * Nested objects and native arrays are preserved with leaf types normalized
 * (ideal for Meilisearch and document search engines).
 *
 * Applies optional field exclusions, column renames, and custom `transformDoc`.
 */
export function serializeDocument(
  doc: Record<string, unknown>,
  options?: Pick<
    RepoSyncConfig,
    "exclude" | "columnMap" | "flat" | "transformDoc"
  >,
): Record<string, unknown> {
  const isFlat = options?.flat !== false;
  let result: Record<string, unknown>;

  if (isFlat) {
    const exclude = new Set(options?.exclude);
    const columnMap = options?.columnMap ?? {};

    // First flatten the document
    const flat: Record<string, unknown> = {};
    flattenObject(doc, "", flat);

    // Then apply excludes and column renames
    result = {};
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
  } else {
    const exclude = new Set(options?.exclude);
    const columnMap = (options?.columnMap ?? {}) as Record<string, string>;
    result = serializeNestedObject(doc, exclude, columnMap);
  }

  if (typeof options?.transformDoc === "function") {
    result = options.transformDoc(result);
  }

  return result;
}
