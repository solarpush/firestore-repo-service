import type { Query } from "firebase-admin/firestore";
import type { QueryOptions } from "./types";

/**
 * Split an array into chunks of specified size
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Capitalize first letter of a string
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Apply QueryOptions to a Firestore query.
 * Handles where, orderBy, limit, offset, select and cursor-based pagination.
 * Does NOT handle orWhere — use buildAndExecuteQuery for that.
 */
export function applyQueryOptions<T>(
  q: Query,
  options: QueryOptions<T>,
): Query {
  if (options.where) {
    options.where.forEach(([field, operator, value]) => {
      q = q.where(String(field), operator, value);
    });
  }

  if (options.orderBy) {
    options.orderBy.forEach((o) => {
      q = q.orderBy(String(o.field), o.direction ?? "asc");
    });
  }

  if (options.limit) {
    q = q.limit(options.limit);
  }

  if (options.offset) {
    q = q.offset(options.offset);
  }

  if (options.select && options.select.length > 0) {
    q = q.select(...options.select.map((f) => String(f)));
  }

  if (options.startAt) {
    q = Array.isArray(options.startAt)
      ? q.startAt(...options.startAt)
      : q.startAt(options.startAt);
  }

  if (options.startAfter) {
    q = Array.isArray(options.startAfter)
      ? q.startAfter(...options.startAfter)
      : q.startAfter(options.startAfter);
  }

  if (options.endAt) {
    q = Array.isArray(options.endAt)
      ? q.endAt(...options.endAt)
      : q.endAt(options.endAt);
  }

  if (options.endBefore) {
    q = Array.isArray(options.endBefore)
      ? q.endBefore(...options.endBefore)
      : q.endBefore(options.endBefore);
  }

  return q;
}
