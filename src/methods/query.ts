import type {
  DocumentReference,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import {
  createPaginationIterator,
  executePaginatedQuery,
  type PaginationOptions,
} from "../pagination";
import type { QueryOptions } from "../shared/types";
import { capitalize } from "../shared/utils";

/**
 * Injects auto-generated fields into the result
 */
function injectAutoFields<T>(
  data: any,
  docRef: DocumentReference,
  autoFields?: { [K in keyof T]?: (docRef: DocumentReference) => T[K] }
): T {
  const result = { ...data };

  if (autoFields) {
    for (const field in autoFields) {
      const generator = autoFields[field as keyof T];
      if (generator) {
        result[field] = generator(docRef);
      }
    }
  }

  return result as T;
}

/**
 * Apply query options to a Firestore query
 */
export function applyQueryOptions(q: Query, options: QueryOptions): Query {
  if (options.where) {
    options.where.forEach((w) => {
      q = q.where(String(w.field), w.operator, w.value);
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
 * Creates query.by* methods for query keys
 */
export function createQueryMethods<T>(
  collectionRef: Query,
  queryKeys: readonly string[],
  autoFields?: { [K in keyof T]?: (docRef: DocumentReference) => T[K] }
) {
  const queryMethods: any = {};

  // Generate query.by* methods for each query key
  queryKeys.forEach((queryKey: string) => {
    const methodName = `by${capitalize(String(queryKey))}`;
    queryMethods[methodName] = async (
      value: string,
      options: QueryOptions = {}
    ): Promise<T[]> => {
      let q: Query = collectionRef as any;
      q = q.where(String(queryKey), "==", value);
      q = applyQueryOptions(q, options);
      const snapshot: QuerySnapshot = await q.get();
      return snapshot.docs.map((doc) =>
        injectAutoFields<T>(doc.data(), doc.ref, autoFields)
      );
    };
  });

  // Generic query.by method
  queryMethods.by = async (options: QueryOptions): Promise<T[]> => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);
    const snapshot: QuerySnapshot = await q.get();
    return snapshot.docs.map((doc) =>
      injectAutoFields<T>(doc.data(), doc.ref, autoFields)
    );
  };

  // getAll - retrieve all documents
  queryMethods.getAll = async (options: QueryOptions = {}): Promise<T[]> => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);
    const snapshot: QuerySnapshot = await q.get();
    return snapshot.docs.map((doc) =>
      injectAutoFields<T>(doc.data(), doc.ref, autoFields)
    );
  };

  // onSnapshot - real-time listener
  queryMethods.onSnapshot = (
    options: QueryOptions,
    onNext: (data: T[]) => void,
    onError?: (error: Error) => void
  ): (() => void) => {
    let q: Query = collectionRef as any;
    q = applyQueryOptions(q, options);

    return q.onSnapshot((snapshot) => {
      const data = snapshot.docs.map((doc) =>
        injectAutoFields<T>(doc.data(), doc.ref, autoFields)
      );
      onNext(data);
    }, onError);
  };

  // Pagination methods
  queryMethods.paginate = async (options: PaginationOptions<any>) => {
    return executePaginatedQuery(collectionRef as Query, options);
  };

  queryMethods.paginateAll = (
    options: Omit<PaginationOptions<any>, "cursor" | "direction">
  ) => {
    return createPaginationIterator(collectionRef as Query, options);
  };

  return queryMethods;
}
