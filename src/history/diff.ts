/**
 * Diff helper for the history module.
 *
 * Computes a top-level shallow diff between two snapshots of the same
 * document. Returns an empty changes object when nothing relevant changed.
 *
 * Meta fields, system keys (docId / pathKey / createdKey / updatedKey) and
 * any field listed in `exclude` are filtered out. When `include` is set, only
 * the listed fields are considered.
 */

import { Timestamp } from "firebase-admin/firestore";
import type {
  HistoryFieldChange,
  HistoryValueType,
} from "./types";

export interface DiffOptions {
  include?: string[];
  exclude?: string[];
  /** Field names that hold meta info (auto-excluded from diff). */
  metaFields?: string[];
  /** System keys auto-excluded (docId, pathKey, createdKey, updatedKey). */
  systemKeys?: string[];
}

export function valueType(v: unknown): HistoryValueType {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (v instanceof Timestamp) return "timestamp";
  if (v instanceof Date) return "date";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

/** Cheap structural equality good enough for change detection. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }

  if (a instanceof Timestamp && b instanceof Timestamp) {
    return a.isEqual(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Compute a flat top-level diff. Nested objects are compared as a whole — they
 * appear in the diff if changed but are NOT decomposed key by key.
 */
export function computeDiff<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  opts: DiffOptions = {},
): Record<string, HistoryFieldChange> {
  const excludeSet = new Set<string>([
    ...(opts.exclude ?? []),
    ...(opts.metaFields ?? []),
    ...(opts.systemKeys ?? []),
  ]);
  const includeSet = opts.include ? new Set<string>(opts.include) : null;

  const beforeObj = (before ?? {}) as Record<string, unknown>;
  const afterObj = (after ?? {}) as Record<string, unknown>;

  const keys = new Set<string>([
    ...Object.keys(beforeObj),
    ...Object.keys(afterObj),
  ]);

  const changes: Record<string, HistoryFieldChange> = {};
  for (const key of keys) {
    if (excludeSet.has(key)) continue;
    if (includeSet && !includeSet.has(key)) continue;

    const oldValue = beforeObj[key];
    const newValue = afterObj[key];
    if (valuesEqual(oldValue, newValue)) continue;

    changes[key] = {
      oldValue: oldValue === undefined ? null : oldValue,
      newValue: newValue === undefined ? null : newValue,
      type: { old: valueType(oldValue), new: valueType(newValue) },
    };
  }

  return changes;
}
