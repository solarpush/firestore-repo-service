import type { Query, QuerySnapshot } from "firebase-admin/firestore";
import type { QueryOptions, WhereClause } from "./shared/types";

/**
 * Chunk array into smaller arrays
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Apply basic query options (orderBy, limit, offset, cursors)
 */
function applyBasicQueryOptions<T>(q: Query, options: QueryOptions<T>): Query {
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
 * Check if a where clause needs splitting (in or array-contains-any with > 30 values)
 */
function needsSplitting<T>(clause: WhereClause<T>): boolean {
  const [, operator, value] = clause;
  return (
    (operator === "in" || operator === "array-contains-any") &&
    Array.isArray(value) &&
    value.length > 30
  );
}

/**
 * Split a where clause into multiple clauses (for in/array-contains-any)
 */
function splitWhereClause<T>(clause: WhereClause<T>): WhereClause<T>[] {
  const [field, operator, value] = clause;

  if (!needsSplitting(clause)) {
    return [clause];
  }

  // Split array into chunks of 30
  const chunks = chunkArray(value as any[], 30);
  return chunks.map((chunk) => [field, operator, chunk] as WhereClause<T>);
}

/**
 * Apply where clauses to a query, handling splits for in/array-contains-any
 */
function applyWhereClausesToQuery<T>(
  baseQuery: Query,
  whereClauses: WhereClause<T>[]
): Query {
  let q = baseQuery;

  for (const [field, operator, value] of whereClauses) {
    q = q.where(String(field), operator, value);
  }

  return q;
}

/**
 * Execute multiple queries in parallel and merge results
 */
async function executeAndMergeQueries(
  queries: Query[]
): Promise<QuerySnapshot> {
  const snapshots = await Promise.all(queries.map((q) => q.get()));

  // Merge all documents, removing duplicates by ID
  const docsMap = new Map();
  snapshots.forEach((snapshot) => {
    snapshot.docs.forEach((doc) => {
      if (!docsMap.has(doc.id)) {
        docsMap.set(doc.id, doc);
      }
    });
  });

  // Return first snapshot with merged docs
  const firstSnapshot = snapshots[0];
  if (!firstSnapshot) {
    throw new Error("No snapshots returned");
  }

  // Create a merged snapshot-like object
  return {
    ...firstSnapshot,
    docs: Array.from(docsMap.values()),
    size: docsMap.size,
    empty: docsMap.size === 0,
  } as QuerySnapshot;
}

/**
 * Build and execute query with automatic splitting for in/array-contains-any
 * Handles both simple AND conditions and complex OR conditions
 */
export async function buildAndExecuteQuery<T>(
  baseQuery: Query,
  options: QueryOptions<T>
): Promise<QuerySnapshot> {
  // Case 1: Simple AND query with where
  if (options.where && !options.orWhere) {
    // Check if any clause needs splitting
    const needsSplit = options.where.some(needsSplitting);

    if (!needsSplit) {
      // Simple case: no splitting needed
      let q = applyWhereClausesToQuery(baseQuery, options.where);
      q = applyBasicQueryOptions(q, options);
      return q.get();
    }

    // Split clauses that need it
    const splitClauses: WhereClause<T>[][] =
      options.where.map(splitWhereClause);

    // Generate all combinations (Cartesian product)
    const combinations = cartesianProduct(splitClauses);

    // Create queries for each combination
    const queries = combinations.map((combination) => {
      let q = applyWhereClausesToQuery(baseQuery, combination);
      q = applyBasicQueryOptions(q, options);
      return q;
    });

    return executeAndMergeQueries(queries);
  }

  // Case 2: OR query with orWhere
  if (options.orWhere) {
    const allQueries: Query[] = [];

    for (const orGroup of options.orWhere) {
      // Check if any clause in this OR group needs splitting
      const needsSplit = orGroup.some(needsSplitting);

      if (!needsSplit) {
        // Simple case for this OR group
        let q = applyWhereClausesToQuery(baseQuery, orGroup);
        q = applyBasicQueryOptions(q, options);
        allQueries.push(q);
      } else {
        // Split clauses that need it
        const splitClauses = orGroup.map(splitWhereClause);

        // Generate all combinations for this OR group
        const combinations = cartesianProduct(splitClauses);

        // Create queries for each combination
        const groupQueries = combinations.map((combination) => {
          let q = applyWhereClausesToQuery(baseQuery, combination);
          q = applyBasicQueryOptions(q, options);
          return q;
        });

        allQueries.push(...groupQueries);
      }
    }

    return executeAndMergeQueries(allQueries);
  }

  // Case 3: No where clauses, just apply basic options
  const q = applyBasicQueryOptions(baseQuery, options);
  return q.get();
}

/**
 * Generate Cartesian product of arrays
 * Example: [[a,b], [1,2]] => [[a,1], [a,2], [b,1], [b,2]]
 */
function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [[]];

  const first = arrays[0];
  if (arrays.length === 1 && first) {
    return first.map((item) => [item]);
  }

  if (!first) return [[]];

  const rest = arrays.slice(1);
  const restProduct = cartesianProduct(rest);

  const result: T[][] = [];
  for (const item of first) {
    for (const combo of restProduct) {
      result.push([item, ...combo]);
    }
  }

  return result;
}
