/* eslint-disable @typescript-eslint/no-empty-object-type */

import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
  WriteBatch,
} from "firebase-admin/firestore";

// Re-export types and utilities from modules
export type {
  ExtractDocumentRefSignature,
  ExtractUpdateSignature,
  GetResult,
  QueryOptions,
  RepositoryConfig,
  WhereClause,
} from "./src/types";

export type { PaginationOptions, PaginationResult } from "./src/pagination";

export {
  applyQueryOptions,
  createPaginationIterator,
  executePaginatedQuery,
} from "./src/pagination";

export { buildAndExecuteQuery } from "./src/query-builder";

import type { GetResult, QueryOptions, RepositoryConfig } from "./src/types";

import {
  createPaginationIterator,
  executePaginatedQuery,
  type PaginationOptions,
} from "./src/pagination";

/**
 * Example repository mapping configuration
 * You must define your own mapping according to your data models
 *
 * @example
 * ```typescript
 * interface UserModel {
 *   docId: string;
 *   email: string;
 *   name: string;
 *   createdAt: Date;
 * }
 *
 * const repositoryMapping = {
 *   users: createRepositoryConfig({
 *     path: "users",
 *     isGroup: false,
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["name"] as const,
 *     type: {} as UserModel,
 *     refCb: (db, docId: string) => db.collection("users").doc(docId),
 *   }),
 * } as const;
 * ```
 */
const repositoryMapping = {} as const;

/**
 * Helper to create a typed repository configuration with literal type preservation
 * @template T - The data model type
 * @template TForeignKeys - Readonly array of foreign keys
 * @template TQueryKeys - Readonly array of query keys
 * @template TIsGroup - Boolean indicating if it's a collection group
 * @template TRefCb - Type of the reference callback function
 * @param config - Repository configuration object
 * @returns Configured repository with typed methods
 * @example
 * ```typescript
 * const usersRepo = createRepositoryConfig({
 *   path: "users",
 *   isGroup: false,
 *   foreignKeys: ["docId", "email"] as const,
 *   queryKeys: ["isActive"] as const,
 *   type: {} as UserModel,
 *   refCb: (db, docId: string) => db.collection("users").doc(docId),
 * });
 * ```
 */
export function createRepositoryConfig<
  T,
  const TForeignKeys extends readonly (keyof T)[],
  const TQueryKeys extends readonly (keyof T)[],
  const TIsGroup extends boolean,
  TRefCb = undefined
>(config: {
  path: string;
  isGroup: TIsGroup;
  foreignKeys: TForeignKeys;
  queryKeys: TQueryKeys;
  type: T;
  refCb: TRefCb;
}): RepositoryConfig<T, TForeignKeys, TQueryKeys, TIsGroup, TRefCb> {
  // documentRef and update will be created in the class constructor with the actual db instance
  return {
    ...config,
    documentRef: null as any, // Will be replaced in constructor
    update: null as any, // Will be replaced in constructor
  };
}

/**
 * Generates get.by* methods from foreign keys
 * @internal
 */
type GenerateGetMethods<TConfig extends RepositoryConfig<any, any, any, any>> =
  {
    [K in TConfig["foreignKeys"][number] as K extends string
      ? `by${Capitalize<K>}`
      : never]: <ReturnDoc extends boolean = false>(
      value: TConfig["type"][K],
      returnDoc?: ReturnDoc
    ) => Promise<GetResult<TConfig["type"], ReturnDoc>>;
  };

/**
 * Generates query.by* methods from query keys
 * @internal
 */
type GenerateQueryMethods<
  TConfig extends RepositoryConfig<any, any, any, any>
> = {
  [K in TConfig["queryKeys"][number] as K extends string
    ? `by${Capitalize<K>}`
    : never]: (
    value: TConfig["type"][K],
    options?: QueryOptions<TConfig["type"]>
  ) => Promise<TConfig["type"][]>;
};

/**
 * Configured repository with organized methods
 * @internal
 */
type ConfiguredRepository<T extends RepositoryConfig<any, any, any, any>> = {
  /** Firestore collection reference */
  ref: CollectionReference | Query;

  /** Retrieval methods (getBy*) */
  get: GenerateGetMethods<T> & {
    /** Retrieves multiple documents by a list of values for a given key */
    byList: <K extends keyof T["type"], ReturnDoc extends boolean = false>(
      key: K,
      values: T["type"][K][],
      operator?: "in" | "array-contains-any",
      returnDoc?: ReturnDoc
    ) => Promise<
      ReturnDoc extends true
        ? Array<{
            data: T["type"];
            doc: DocumentSnapshot;
          }>
        : T["type"][]
    >;
  };

  /** Query methods (queryBy*) */
  query: GenerateQueryMethods<T> & {
    by: (options: QueryOptions<T["type"]>) => Promise<T["type"][]>;
    getAll: (options?: QueryOptions<T["type"]>) => Promise<T["type"][]>;
    onSnapshot: (
      options: QueryOptions<T["type"]>,
      onNext: (data: T["type"][]) => void,
      onError?: (error: Error) => void
    ) => () => void;
    /** Executes a paginated query with cursor-based pagination */
    paginate: (
      options: PaginationOptions<T["type"]>
    ) => ReturnType<typeof executePaginatedQuery<T["type"]>>;
    /** Creates an async iterator for iterating through all pages */
    paginateAll: (
      options: Omit<PaginationOptions<T["type"]>, "cursor" | "direction">
    ) => ReturnType<typeof createPaginationIterator<T["type"]>>;
  };

  /** Aggregate methods for server-side computations */
  aggregate: {
    /**
     * Gets the count of documents matching the query options
     * @param options - Optional query options to filter documents
     * @returns Promise with the count of documents
     * @example
     * ```typescript
     * const count = await repos.users.aggregate.count();
     * const activeCount = await repos.users.aggregate.count({
     *   where: [{ field: 'isActive', operator: '==', value: true }]
     * });
     * ```
     */
    count: (options?: QueryOptions<T["type"]>) => Promise<number>;

    /**
     * Gets the sum of a numeric field across documents matching the query options
     * @param field - The field to sum
     * @param options - Optional query options to filter documents
     * @returns Promise with the sum value
     * @example
     * ```typescript
     * const totalAge = await repos.users.aggregate.sum('age');
     * const activeUsersAge = await repos.users.aggregate.sum('age', {
     *   where: [{ field: 'isActive', operator: '==', value: true }]
     * });
     * ```
     */
    sum: <K extends keyof T["type"]>(
      field: K,
      options?: QueryOptions<T["type"]>
    ) => Promise<number>;

    /**
     * Gets the average of a numeric field across documents matching the query options
     * @param field - The field to average
     * @param options - Optional query options to filter documents
     * @returns Promise with the average value
     * @example
     * ```typescript
     * const avgAge = await repos.users.aggregate.average('age');
     * const activeUsersAvgAge = await repos.users.aggregate.average('age', {
     *   where: [{ field: 'isActive', operator: '==', value: true }]
     * });
     * ```
     */
    average: <K extends keyof T["type"]>(
      field: K,
      options?: QueryOptions<T["type"]>
    ) => Promise<number | null>;
  };

  /** Method to get a document reference */
  documentRef: T["documentRef"];

  /**
   * Creates a new document with auto-generated ID
   * @param data - Document data
   * @returns Promise with the created document including its generated ID
   */
  create: (data: Partial<T["type"]>) => Promise<T["type"] & { docId: string }>;

  /**
   * Sets a document (creates or replaces)
   * @param args - Path arguments followed by data and optional merge option
   * @returns Promise with the set document
   */
  set: (
    ...args: [
      ...Parameters<T["documentRef"]>,
      Partial<T["type"]>,
      { merge?: boolean }?
    ]
  ) => Promise<T["type"]>;

  /** Updates a document and returns the updated data */
  update: T["update"];

  /**
   * Deletes a document
   * @param args - Path arguments for the document to delete
   * @returns Promise that resolves when deletion is complete
   */
  delete: (...args: Parameters<T["documentRef"]>) => Promise<void>;

  /** Batch operations for atomic transactions */
  batch: {
    /** Creates a batch for atomic operations */
    create: () => {
      batch: WriteBatch;
      set: (
        ...args: [
          ...Parameters<T["documentRef"]>,
          Partial<T["type"]>,
          { merge?: boolean }?
        ]
      ) => void;
      update: (
        ...args: [...Parameters<T["documentRef"]>, Partial<T["type"]>]
      ) => void;
      delete: (...args: Parameters<T["documentRef"]>) => void;
      commit: () => Promise<void>;
    };
  };

  /** Transaction operations for atomic read-write operations */
  transaction: {
    /**
     * Runs a transaction with type-safe read and write operations
     * @param updateFunction - Function that receives a typed transaction wrapper
     * @returns Promise that resolves with the transaction result
     * @example
     * ```typescript
     * await repos.users.transaction.run(async (txn) => {
     *   const user = await txn.get("user123");
     *   if (user) {
     *     await txn.update("user123", { balance: user.balance + 100 });
     *   }
     * });
     * ```
     */
    run: <R>(
      updateFunction: (transaction: {
        /** Get a document by its reference (type-safe) */
        get: (
          ...args: Parameters<T["documentRef"]>
        ) => Promise<T["type"] | null>;
        /** Set a document (type-safe) */
        set: (
          ...args: [
            ...Parameters<T["documentRef"]>,
            Partial<T["type"]>,
            { merge?: boolean }?
          ]
        ) => void;
        /** Update a document (type-safe) */
        update: (
          ...args: [...Parameters<T["documentRef"]>, Partial<T["type"]>]
        ) => void;
        /** Delete a document */
        delete: (...args: Parameters<T["documentRef"]>) => void;
        /** Access raw Firestore transaction if needed */
        raw: Transaction;
      }) => Promise<R>
    ) => Promise<R>;
  };

  /** Bulk operations for processing large quantities */
  bulk: {
    /** Creates/updates multiple documents (automatically divided into batches of 500) */
    set: (
      items: Array<{
        docRef: DocumentReference;
        data: Partial<T["type"]>;
        merge?: boolean;
      }>
    ) => Promise<void>;

    /** Updates multiple documents (automatically divided into batches of 500) */
    update: (
      items: Array<{
        docRef: DocumentReference;
        data: Partial<T["type"]>;
      }>
    ) => Promise<void>;

    /** Deletes multiple documents (automatically divided into batches of 500) */
    delete: (docRefs: DocumentReference[]) => Promise<void>;
  };
};

/**
 * Repository mapping class that manages Firestore repositories with type safety
 * @template T - Record of repository configurations
 */
export class RepositoryMapping<
  T extends Record<string, any> = typeof repositoryMapping
> {
  private db: Firestore;
  private repositoryCache = new Map<string, any>();
  private mapping: T;

  /**
   * Creates a new RepositoryMapping instance
   * @param db - Firestore instance from firebase-admin
   * @param mapping - Repository configuration mapping
   */
  constructor(db: Firestore, mapping: T) {
    this.db = db;
    this.mapping = mapping;
  }

  /**
   * Gets a repository with lazy loading
   * @template K - Repository key
   * @param key - Repository identifier
   * @returns Configured repository instance
   */
  getRepository<K extends keyof T>(key: K): ConfiguredRepository<T[K]> {
    if (!this.repositoryCache.has(key as string)) {
      this.repositoryCache.set(key as string, this.createRepository(key));
    }
    return this.repositoryCache.get(key as string)!;
  }

  // Getters are automatically generated via a Proxy (see createRepositoryMapping)

  /**
   * Creates a configured repository instance
   * @private
   * @template K - Repository key
   * @param key - Repository identifier
   * @returns Configured repository with all methods
   */
  private createRepository<K extends keyof T>(
    key: K
  ): ConfiguredRepository<T[K]> {
    const element = this.mapping[key];
    const collectionRef: CollectionReference | Query = element.isGroup
      ? this.db.collectionGroup(element.path)
      : this.db.collection(element.path);

    // Keep a reference to the actual collection for create operations
    const actualCollection = element.isGroup
      ? null
      : this.db.collection(element.path);

    const getMethods: any = {};
    const queryMethods: any = {};

    // Create the documentRef method with the db instance
    const documentRef = (...args: any[]) =>
      (element.refCb as any)(this.db, ...args);

    // Helper to split an array into chunks
    const chunkArray = <T>(array: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    };

    // Add get.byList method to retrieve by batches
    getMethods.byList = async (
      key: string,
      values: any[],
      operator: "in" | "array-contains-any" = "in",
      returnDoc = false
    ): Promise<any[]> => {
      if (values.length === 0) return [];

      const results: any[] = [];
      const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

      for (const chunk of chunks) {
        let q: Query = collectionRef as any;
        q = q.where(key, operator, chunk);
        const snapshot: QuerySnapshot = await q.get();

        snapshot.forEach((doc) => {
          const data = doc.data();
          results.push(returnDoc ? { data, doc } : { ...data, docId: doc.id });
        });
      }

      return results;
    };

    // Generate ONLY get.by* methods for defined foreignKeys
    element.foreignKeys.forEach((foreignKey: string) => {
      const capitalizedKey =
        String(foreignKey).charAt(0).toUpperCase() +
        String(foreignKey).slice(1);
      const getMethodName = `by${capitalizedKey}`;
      getMethods[getMethodName] = async (
        value: string,
        returnDoc = false
      ): Promise<any | null> => {
        let q: Query = collectionRef as any;
        q = q.where(String(foreignKey), "==", value).limit(1);
        const snapshot: QuerySnapshot = await q.get();
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        if (!doc) return null;
        const data = doc.data();
        return returnDoc ? { data, doc } : { ...data, docId: doc.id };
      };
    });

    // Generate ONLY query.by* methods for defined queryKeys
    element.queryKeys.forEach((queryKey: string) => {
      const capitalizedKey =
        String(queryKey).charAt(0).toUpperCase() + String(queryKey).slice(1);
      const queryMethodName = `by${capitalizedKey}`;
      queryMethods[queryMethodName] = async (
        value: string,
        options: QueryOptions = {}
      ): Promise<any[]> => {
        let q: Query = collectionRef as any;
        q = q.where(String(queryKey), "==", value);
        q = applyQueryOptions(q, options);
        const snapshot: QuerySnapshot = await q.get();
        return snapshot.docs.map((doc) => ({ ...doc.data(), docId: doc.id }));
      };
    });

    // Helper function to apply query options
    const applyQueryOptions = (q: Query, options: QueryOptions): Query => {
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
    };

    // Add generic query.by method
    queryMethods.by = async (options: QueryOptions): Promise<any[]> => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);
      const snapshot: QuerySnapshot = await q.get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), docId: doc.id }));
    };

    // Add getAll method to retrieve all documents from the collection
    queryMethods.getAll = async (
      options: QueryOptions = {}
    ): Promise<any[]> => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);
      const snapshot: QuerySnapshot = await q.get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), docId: doc.id }));
    };

    // Add onSnapshot method for real-time listeners
    queryMethods.onSnapshot = (
      options: QueryOptions,
      onNext: (data: any[]) => void,
      onError?: (error: Error) => void
    ): (() => void) => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);

      return q.onSnapshot((snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          ...doc.data(),
          docId: doc.id,
        }));
        onNext(data);
      }, onError);
    };

    // Add pagination methods
    queryMethods.paginate = async (options: PaginationOptions<any>) => {
      return executePaginatedQuery(collectionRef as Query, options);
    };

    queryMethods.paginateAll = (
      options: Omit<PaginationOptions<any>, "cursor" | "direction">
    ) => {
      return createPaginationIterator(collectionRef as Query, options);
    };

    // Aggregate methods for server-side computations
    const aggregateMethods = {
      // Count documents matching query options
      count: async (options: QueryOptions = {}): Promise<number> => {
        let q: Query = collectionRef as any;
        q = applyQueryOptions(q, options);
        const snapshot = await q.count().get();
        return snapshot.data().count;
      },

      // Sum of a numeric field
      sum: async (
        field: string,
        options: QueryOptions = {}
      ): Promise<number> => {
        let q: Query = collectionRef as any;
        q = applyQueryOptions(q, options);
        const snapshot = await q.get();

        let total = 0;
        snapshot.forEach((doc) => {
          const value = doc.data()[field];
          if (typeof value === "number") {
            total += value;
          }
        });

        return total;
      },

      // Average of a numeric field
      average: async (
        field: string,
        options: QueryOptions = {}
      ): Promise<number | null> => {
        let q: Query = collectionRef as any;
        q = applyQueryOptions(q, options);
        const snapshot = await q.get();

        if (snapshot.empty) return null;

        let total = 0;
        let count = 0;

        snapshot.forEach((doc) => {
          const value = doc.data()[field];
          if (typeof value === "number") {
            total += value;
            count++;
          }
        });

        return count > 0 ? total / count : null;
      },
    };

    // Create method - adds a new document with auto-generated ID
    const create = async (data: any): Promise<any> => {
      if (!actualCollection) {
        throw new Error(
          "Cannot use create() on collection groups. Use set() with a specific document ID instead."
        );
      }
      const docRef = await actualCollection.add(data);
      const createdDoc = await docRef.get();
      return { ...createdDoc.data(), docId: docRef.id };
    };

    // Set method - creates or replaces a document
    const set = async (...args: any[]): Promise<any> => {
      const lastArg = args[args.length - 1];
      const hasOptions =
        typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

      const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
      const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
      const mergeOption = hasOptions ? lastArg : { merge: true };

      const docRef = documentRef(...pathArgs);
      await docRef.set(data, mergeOption);

      // Fetch and return the set document
      const setDocument = await docRef.get();
      return { ...setDocument.data(), docId: docRef.id };
    };

    // Update method that uses documentRef and returns the merged object
    const update = async (...args: any[]): Promise<any> => {
      const data = args.pop(); // Last argument is always the data
      const pathArgs = args; // Rest are path arguments

      const docRef = documentRef(...pathArgs);
      await docRef.update(data);

      // Fetch and return the updated object
      const updatedDoc = await docRef.get();
      return { ...updatedDoc.data(), docId: docRef.id };
    };

    // Delete method - removes a document
    const deleteMethod = async (...args: any[]): Promise<void> => {
      const docRef = documentRef(...args);
      await docRef.delete();
    };

    // Batch methods for atomic operations
    const batchMethods = {
      create: () => {
        const batch = this.db.batch();
        return {
          batch,
          set: (...args: any[]) => {
            const lastArg = args[args.length - 1];
            const hasOptions =
              typeof lastArg === "object" &&
              lastArg !== null &&
              "merge" in lastArg;

            const data = hasOptions
              ? args[args.length - 2]
              : args[args.length - 1];
            const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
            const mergeOption = hasOptions ? lastArg : { merge: true };

            const docRef = documentRef(...pathArgs);
            batch.set(docRef, data, mergeOption);
          },
          update: (...args: any[]) => {
            const data = args.pop();
            const pathArgs = args;
            const docRef = documentRef(...pathArgs);
            batch.update(docRef, data);
          },
          delete: (...args: any[]) => {
            const docRef = documentRef(...args);
            batch.delete(docRef);
          },
          commit: async () => {
            await batch.commit();
          },
        };
      },
    };

    // Transaction methods for atomic read-write operations
    const transactionMethods = {
      run: async <R>(
        updateFunction: (transaction: any) => Promise<R>
      ): Promise<R> => {
        return this.db.runTransaction(async (rawTransaction) => {
          // Create a typed transaction wrapper
          const typedTransaction = {
            // Type-safe get method
            get: async (...args: any[]) => {
              const docRef = documentRef(...args);
              const docSnap = (await rawTransaction.get(docRef)) as any;
              if (!docSnap.exists) return null;
              return { ...docSnap.data(), docId: docSnap.id } as any;
            },

            // Type-safe set method
            set: (...args: any[]) => {
              const options = args[args.length - 1];
              const hasOptions =
                typeof options === "object" &&
                options !== null &&
                "merge" in options;

              const data = hasOptions
                ? args[args.length - 2]
                : args[args.length - 1];
              const pathArgs = hasOptions
                ? args.slice(0, -2)
                : args.slice(0, -1);
              const mergeOption = hasOptions ? options : { merge: true };

              const docRef = documentRef(...pathArgs);
              rawTransaction.set(docRef, data, mergeOption);
            },

            // Type-safe update method
            update: (...args: any[]) => {
              const data = args[args.length - 1];
              const pathArgs = args.slice(0, -1);
              const docRef = documentRef(...pathArgs);
              rawTransaction.update(docRef, data);
            },

            // Delete method
            delete: (...args: any[]) => {
              const docRef = documentRef(...args);
              rawTransaction.delete(docRef);
            },

            // Access to raw transaction if needed
            raw: rawTransaction,
          };

          return updateFunction(typedTransaction);
        });
      },
    };

    // Bulk methods using BulkWriter with manual flush every 500 operations
    const bulkMethods = {
      set: async (
        items: Array<{
          docRef: DocumentReference;
          data: any;
          merge?: boolean;
        }>
      ) => {
        const bulkWriter = this.db.bulkWriter();
        let pendingOps = 0;

        for (const item of items) {
          if (!item) continue;
          const { docRef, data, merge = true } = item;
          bulkWriter.set(docRef, data, { merge });
          pendingOps++;

          // Flush every 500 operations to control memory usage
          if (pendingOps >= 500) {
            await bulkWriter.flush();
            pendingOps = 0;
          }
        }

        await bulkWriter.close();
      },

      update: async (
        items: Array<{ docRef: DocumentReference; data: any }>
      ) => {
        const bulkWriter = this.db.bulkWriter();
        let pendingOps = 0;

        for (const item of items) {
          if (!item) continue;
          const { docRef, data } = item;
          bulkWriter.update(docRef, data);
          pendingOps++;

          if (pendingOps >= 500) {
            await bulkWriter.flush();
            pendingOps = 0;
          }
        }

        await bulkWriter.close();
      },

      delete: async (docRefs: DocumentReference[]) => {
        const bulkWriter = this.db.bulkWriter();
        let pendingOps = 0;

        for (const docRef of docRefs) {
          if (!docRef) continue;
          bulkWriter.delete(docRef);
          pendingOps++;

          if (pendingOps >= 500) {
            await bulkWriter.flush();
            pendingOps = 0;
          }
        }

        await bulkWriter.close();
      },
    };

    return {
      ref: collectionRef,
      documentRef,
      create,
      set,
      update,
      delete: deleteMethod,
      get: getMethods,
      query: queryMethods,
      aggregate: aggregateMethods,
      batch: batchMethods,
      transaction: transactionMethods,
      bulk: bulkMethods,
    } as unknown as ConfiguredRepository<T[K]>;
  }
}

/**
 * Helper function to create a RepositoryMapping instance with full typing
 * @template T - Record of repository configurations
 * @param db - Firestore instance from firebase-admin
 * @param mapping - Repository configurations
 * @returns RepositoryMapping instance with repository access via getters
 * @example
 * ```typescript
 * import * as admin from 'firebase-admin';
 *
 * admin.initializeApp();
 * const db = admin.firestore();
 *
 * const repos = createRepositoryMapping(db, {
 *   users: createRepositoryConfig({
 *     path: "users",
 *     isGroup: false,
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["isActive"] as const,
 *     type: {} as UserModel,
 *     refCb: (db, docId: string) => db.collection("users").doc(docId),
 *   }),
 * });
 *
 * // Access repositories directly
 * const user = await repos.users.get.byDocId("123");
 * ```
 */
export function createRepositoryMapping<T extends Record<string, any>>(
  db: Firestore,
  mapping: T
): RepositoryMapping<T> & { [K in keyof T]: ConfiguredRepository<T[K]> } {
  const instance = new RepositoryMapping(db, mapping);

  // Create a Proxy to dynamically generate getters
  return new Proxy(instance, {
    get(target, prop) {
      if (typeof prop === "string" && prop in mapping) {
        return target.getRepository(prop as keyof T);
      }
      return (target as any)[prop];
    },
  }) as any;
}
