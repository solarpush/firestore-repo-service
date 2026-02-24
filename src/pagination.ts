import type { DocumentSnapshot, Query } from "firebase-admin/firestore";
import { buildAndExecuteQuery } from "./query-builder";
import type { QueryOptions } from "./shared/types";
import { applyQueryOptions } from "./shared/utils";

export { applyQueryOptions };

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
 * Executes a paginated query and returns results with pagination info.
 * Uses the advanced query builder that handles OR conditions and automatic splitting.
 *
 * @template T - Data model type
 * @param baseQuery - Base Firestore query
 * @param options - Pagination options
 * @returns Pagination result with data and cursor information
 *
 * @example
 * ```typescript
 * // Basic pagination
 * const firstPage = await executePaginatedQuery(collectionRef, {
 *   pageSize: 10
 * });
 * console.log(firstPage.data);        // Array of 10 items
 * console.log(firstPage.hasNextPage); // true if more pages exist
 *
 * // Get next page using cursor
 * if (firstPage.hasNextPage) {
 *   const secondPage = await executePaginatedQuery(collectionRef, {
 *     pageSize: 10,
 *     cursor: firstPage.nextCursor,
 *     direction: "next"
 *   });
 * }
 *
 * // Pagination with filters and sorting
 * const filteredPage = await executePaginatedQuery(collectionRef, {
 *   pageSize: 20,
 *   where: [["status", "==", "active"]],
 *   orderBy: [["createdAt", "desc"]],
 *   select: ["title", "status", "createdAt"]
 * });
 *
 * // Pagination with OR conditions
 * const orPage = await executePaginatedQuery(collectionRef, {
 *   pageSize: 10,
 *   orWhere: [
 *     ["status", "==", "published"],
 *     ["status", "==", "featured"]
 *   ]
 * });
 *
 * // Go to previous page
 * const prevPage = await executePaginatedQuery(collectionRef, {
 *   pageSize: 10,
 *   cursor: currentPage.prevCursor,
 *   direction: "prev"
 * });
 * ```
 */
export async function executePaginatedQuery<T>(
  baseQuery: Query,
  options: PaginationOptions<T>,
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

  const isPrev = options.direction === "prev";

  return {
    data,
    // When going "prev": nextCursor always points to last doc of the page (to go forward
    // again), prevCursor only set when there are even earlier docs (hasMore).
    // When going "next" (default): same logic as before.
    nextCursor: isPrev
      ? actualDocs.length > 0
        ? actualDocs[actualDocs.length - 1]
        : undefined
      : hasMore
        ? actualDocs[actualDocs.length - 1]
        : undefined,
    prevCursor: isPrev ? (hasMore ? actualDocs[0] : undefined) : actualDocs[0],
    hasNextPage: isPrev ? !!options.cursor : hasMore,
    hasPrevPage: isPrev ? hasMore : !!options.cursor,
    pageSize: data.length,
  };
}

/**
 * Creates an async generator for iterating through all pages.
 * Useful for processing large datasets without loading everything into memory.
 *
 * @template T - Data model type
 * @param baseQuery - Base Firestore query
 * @param options - Pagination options (without cursor)
 * @yields Pagination results for each page
 *
 * @example
 * ```typescript
 * // Basic iteration through all pages
 * const pageIterator = createPaginationIterator(query, { pageSize: 100 });
 * for await (const page of pageIterator) {
 *   console.log(`Processing ${page.data.length} items`);
 *   for (const item of page.data) {
 *     await processItem(item);
 *   }
 * }
 *
 * // With filters and sorting
 * const filteredIterator = createPaginationIterator(query, {
 *   pageSize: 50,
 *   where: [["status", "==", "pending"]],
 *   orderBy: [["createdAt", "asc"]]
 * });
 *
 * let totalProcessed = 0;
 * for await (const page of filteredIterator) {
 *   totalProcessed += page.data.length;
 *   console.log(`Processed ${totalProcessed} items so far`);
 * }
 *
 * // Export all data to CSV
 * const allData: User[] = [];
 * for await (const page of createPaginationIterator(usersQuery, { pageSize: 500 })) {
 *   allData.push(...page.data);
 * }
 * exportToCsv(allData);
 *
 * // Early exit if condition met
 * for await (const page of createPaginationIterator(query, { pageSize: 100 })) {
 *   const found = page.data.find(item => item.id === targetId);
 *   if (found) {
 *     console.log("Found target item!");
 *     break; // Stop iteration early
 *   }
 * }
 * ```
 */
export async function* createPaginationIterator<T>(
  baseQuery: Query,
  options: Omit<PaginationOptions<T>, "cursor" | "direction">,
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
