import type { DocumentSnapshot, Query } from "firebase-admin/firestore";
import { buildAndExecuteQuery } from "./query-builder";
import type { QueryOptions } from "./shared/types";

/**
 * Pagination result with data and cursor information
 * @template T - Data model type
 */
export interface PaginationResult<T> {
  /** Array of documents for the current page */
  data: T[];
  /** Cursor to the next page (undefined if no more pages) */
  nextCursor?: DocumentSnapshot;
  /** Cursor to the previous page (undefined if on first page) */
  prevCursor?: DocumentSnapshot;
  /** Whether there are more pages after this one */
  hasNextPage: boolean;
  /** Whether there are pages before this one */
  hasPrevPage: boolean;
  /** Total number of items in current page */
  pageSize: number;
}

/**
 * Pagination options for cursor-based pagination
 * @template T - Data model type
 */
export interface PaginationOptions<T> extends Omit<QueryOptions<T>, "limit"> {
  /** Number of items per page */
  pageSize: number;
  /** Cursor to start after (for next page) */
  cursor?: DocumentSnapshot;
  /** Direction of pagination */
  direction?: "next" | "prev";
}

/**
 * Helper to apply query options to a Firestore query
 */
export function applyQueryOptions<T>(
  q: Query,
  options: QueryOptions<T>
): Query {
  if (options.where) {
    options.where.forEach(([field, operator, value]) => {
      q = q.where(String(field), operator, value);
    });
  }

  if (options.orderBy) {
    options.orderBy.forEach((o) => {
      q = q.orderBy(String(o.field), o.direction || "asc");
    });
  }

  if (options.limit) {
    q = q.limit(options.limit);
  }

  if (options.offset) {
    q = q.offset(options.offset);
  }

  // Cursor-based pagination
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

/**
 * Executes a paginated query and returns results with pagination info
 * Uses the advanced query builder that handles OR conditions and automatic splitting
 * @template T - Data model type
 * @param baseQuery - Base Firestore query
 * @param options - Pagination options
 * @returns Pagination result with data and cursor information
 */
export async function executePaginatedQuery<T>(
  baseQuery: Query,
  options: PaginationOptions<T>
): Promise<PaginationResult<T>> {
  // Prepare options with cursor-based pagination
  const queryOptions: QueryOptions<T> = {
    ...options,
    limit: options.pageSize + 1, // Fetch one extra to check if there's a next page
  };

  // Apply cursor
  if (options.cursor) {
    if (options.direction === "prev") {
      queryOptions.endBefore = options.cursor;
    } else {
      queryOptions.startAfter = options.cursor;
    }
  }

  // Use the advanced query builder (handles OR and auto-splitting)
  const snapshot = await buildAndExecuteQuery(baseQuery, queryOptions);
  const docs = snapshot.docs;

  // Check if there are more pages
  const hasMore = docs.length > options.pageSize;
  const actualDocs = hasMore ? docs.slice(0, options.pageSize) : docs;

  const data = actualDocs.map((doc) => ({
    ...doc.data(),
    docId: doc.id,
  })) as T[];

  return {
    data,
    nextCursor: hasMore ? actualDocs[actualDocs.length - 1] : undefined,
    prevCursor: actualDocs[0],
    hasNextPage: hasMore,
    hasPrevPage: !!options.cursor,
    pageSize: data.length,
  };
}

/**
 * Creates an async generator for iterating through all pages
 * @template T - Data model type
 * @param baseQuery - Base Firestore query
 * @param options - Pagination options (without cursor)
 * @yields Pagination results for each page
 * @example
 * ```typescript
 * const pageIterator = createPaginationIterator(query, { pageSize: 10 });
 * for await (const page of pageIterator) {
 *   console.log(`Page with ${page.pageSize} items`);
 *   page.data.forEach(item => console.log(item));
 *   if (!page.hasNextPage) break;
 * }
 * ```
 */
export async function* createPaginationIterator<T>(
  baseQuery: Query,
  options: Omit<PaginationOptions<T>, "cursor" | "direction">
): AsyncGenerator<PaginationResult<T>, void, unknown> {
  let cursor: DocumentSnapshot | undefined;
  let hasMore = true;

  while (hasMore) {
    const result = await executePaginatedQuery<T>(baseQuery, {
      ...options,
      cursor,
      direction: "next",
    });

    yield result;

    hasMore = result.hasNextPage;
    cursor = result.nextCursor;
  }
}
