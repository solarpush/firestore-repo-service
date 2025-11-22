/* eslint-disable @typescript-eslint/no-empty-object-type */

import {
  CollectionReference,
  DocumentReference,
  QuerySnapshot,
  WriteBatch,
  collection,
  collectionGroup,
  and as filterAnd,
  or as filterOr,
  where as filterWhere,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type WhereFilterOp,
} from "firebase/firestore";

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
 *     refCb: (db, docId: string) => doc(db, "users", docId),
 *   }),
 * } as const;
 * ```
 */
const repositoryMapping = {} as const;

/**
 * Extract the documentRef signature from refCb (without the db parameter)
 * @internal
 */
type ExtractDocumentRefSignature<T> = T extends (
  db: Firestore,
  ...args: infer P
) => DocumentReference<DocumentData>
  ? (...args: P) => DocumentReference<DocumentData>
  : never;

/**
 * Extract the update signature from refCb
 * @internal
 */
type ExtractUpdateSignature<T, TType> = T extends (
  db: Firestore,
  ...args: infer P
) => DocumentReference<DocumentData>
  ? (...args: [...P, Partial<TType>]) => Promise<TType>
  : never;

/**
 * Configuration interface for repositories with strict literal type inference
 * @template T - The data model type
 * @template TForeignKeys - Foreign keys used for unique document retrieval (get methods)
 * @template TQueryKeys - Query keys used for multiple document searches (query methods)
 * @template TIsGroup - Whether this is a collection group query
 * @template TRefCb - Callback function signature for creating document references
 */
interface RepositoryConfig<
  T,
  TForeignKeys extends readonly (keyof T)[],
  TQueryKeys extends readonly (keyof T)[],
  TIsGroup extends boolean = boolean,
  TRefCb = any
> {
  /** Firestore collection path */
  path: string;
  /** Whether this is a collection group query */
  isGroup: TIsGroup;
  /** Keys used for unique document retrieval (generates get.by* methods) */
  foreignKeys: TForeignKeys;
  /** Keys used for querying multiple documents (generates query.by* methods) */
  queryKeys: TQueryKeys;
  /** Type definition for the data model */
  type: T;
  /** Callback to construct document reference */
  refCb?: TRefCb;
  /** Exposes the same signature as refCb but without the db parameter */
  documentRef: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...pathSegments: string[]) => DocumentReference<DocumentData>
      : (docId: string) => DocumentReference<DocumentData>
    : ExtractDocumentRefSignature<TRefCb>;
  /** Exposes the same signature as refCb but with data parameter and returns the updated object */
  update: TRefCb extends undefined
    ? TIsGroup extends true
      ? (...args: [...string[], Partial<T>]) => Promise<T>
      : (docId: string, data: Partial<T>) => Promise<T>
    : ExtractUpdateSignature<TRefCb, T>;
}

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
 *   refCb: (db, docId: string) => doc(db, "users", docId),
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
 * Type for a where condition with strict value typing based on the field
 * @template T - Data model type
 * @example
 * ```typescript
 * const condition: WhereClause<EventModel> = {
 *   field: 'status',
 *   operator: '==',
 *   value: 'signed'
 * }
 * ```
 */
export type WhereClause<T = any> = {
  [K in keyof T]: {
    field: K;
    operator: WhereFilterOp;
    value: T[K] | T[K][];
  };
}[keyof T];

/**
 * Type for composite OR/AND conditions
 * @template T - Data model type
 * @deprecated Use QueryOptions with orWhere directly
 */
export type CompositeFilter<T = any> = {
  or?: WhereClause<T>[][];
  and?: WhereClause<T>[];
};

/**
 * Query options for filtering, sorting and paginating results
 * @template T - Data model type
 *
 * @property {WhereClause<T>[]} [where] - Simple AND conditions
 * @property {WhereClause<T>[][]} [orWhere] - Composite OR conditions. Each sub-array represents an AND group, and groups are combined with OR
 * @property {Array<{field: keyof T; direction?: "asc" | "desc"}>} [orderBy] - Sort criteria
 * @property {number} [limit] - Maximum number of results to return
 * @property {number} [offset] - Number of results to skip (pagination)
 *
 * @example
 * // Simple search with AND
 * ```typescript
 * const options: QueryOptions<EventModel> = {
 *   where: [
 *     { field: 'status', operator: '==', value: 'signed' },
 *     { field: 'dateTime', operator: '>=', value: startDate }
 *   ],
 *   orderBy: [{ field: 'dateTime', direction: 'desc' }],
 *   limit: 10
 * }
 * ```
 *
 * @example
 * // Search with OR: (status = 'signed' AND dateTime > date1) OR (status = 'scheduled' AND dateTime > date2)
 * ```typescript
 * const options: QueryOptions<EventModel> = {
 *   orWhere: [
 *     [
 *       { field: 'status', operator: '==', value: 'signed' },
 *       { field: 'dateTime', operator: '>=', value: date1 }
 *     ],
 *     [
 *       { field: 'status', operator: '==', value: 'scheduled' },
 *       { field: 'dateTime', operator: '>=', value: date2 }
 *     ]
 *   ]
 * }
 * ```
 */
export interface QueryOptions<T = any> {
  where?: WhereClause<T>[];
  orWhere?: WhereClause<T>[][];
  orderBy?: { field: keyof T; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
}

/**
 * Result type for get operations with optional document snapshot
 * @internal
 */
type GetResult<T, ReturnDoc extends boolean> = ReturnDoc extends true
  ? { data: T; doc: DocumentSnapshot<DocumentData> } | null
  : T | null;

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
  ref: CollectionReference<DocumentData>;

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
            doc: DocumentSnapshot<DocumentData>;
          }>
        : T["type"][]
    >;
  };

  /** Query methods (queryBy*) */
  query: GenerateQueryMethods<T> & {
    by: (options: QueryOptions<T["type"]>) => Promise<T["type"][]>;
  };

  /** Method to get a document reference */
  documentRef: T["documentRef"];

  /** Method to update a document */
  update: T["update"];

  /** Batch operations for atomic transactions */
  batch: {
    /** Creates a batch for atomic operations */
    create: () => {
      batch: WriteBatch;
      set: (
        docRef: DocumentReference<DocumentData>,
        data: Partial<T["type"]>,
        merge?: boolean
      ) => void;
      update: (
        docRef: DocumentReference<DocumentData>,
        data: Partial<T["type"]>
      ) => void;
      delete: (docRef: DocumentReference<DocumentData>) => void;
      commit: () => Promise<void>;
    };
  };

  /** Bulk operations for processing large quantities */
  bulk: {
    /** Creates/updates multiple documents (automatically divided into batches of 500) */
    set: (
      items: Array<{
        docRef: DocumentReference<DocumentData>;
        data: Partial<T["type"]>;
        merge?: boolean;
      }>
    ) => Promise<void>;

    /** Updates multiple documents (automatically divided into batches of 500) */
    update: (
      items: Array<{
        docRef: DocumentReference<DocumentData>;
        data: Partial<T["type"]>;
      }>
    ) => Promise<void>;

    /** Deletes multiple documents (automatically divided into batches of 500) */
    delete: (docRefs: DocumentReference<DocumentData>[]) => Promise<void>;
  };
};

/**
 * Repository mapping class that manages Firestore repositories with type safety
 * @template T - Record of repository configurations
 */
export class RepositoryMapping<
  T extends Record<string, any> = typeof repositoryMapping
> {
  private db?: Firestore;
  private repositoryCache = new Map<string, any>();
  private mapping: T;

  /**
   * Creates a new RepositoryMapping instance
   * @param mapping - Repository configuration mapping
   */
  constructor(mapping: T) {
    this.mapping = mapping;
  }

  /**
   * Initializes and returns the Firestore instance
   * @private
   * @returns Firestore instance
   */
  private init(): Firestore {
    if (!this.db) {
      this.db = getFirestore();
    }
    return this.db;
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
    const db = this.init();
    const element = this.mapping[key];
    const collectionRef = element.isGroup
      ? collectionGroup(db, element.path)
      : collection(db, element.path);

    const getMethods: any = {};
    const queryMethods: any = {};

    // Create the documentRef method with the db instance
    const documentRef = (...args: any[]) => (element.refCb as any)(db, ...args);

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
        const q = query(collectionRef, where(key, operator, chunk));
        const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);

        snapshot.forEach((doc) => {
          results.push(
            returnDoc ? { data: doc.data(), doc } : { ...doc.data() }
          );
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
        const q = query(
          collectionRef,
          where(String(foreignKey), "==", value),
          limit(1)
        );
        const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        if (!doc) return null;
        return returnDoc ? { data: doc.data(), doc } : { ...doc.data() };
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
        const constraints: any[] = [where(String(queryKey), "==", value)];

        if (options.where) {
          options.where.forEach((w) => {
            constraints.push(where(String(w.field), w.operator, w.value));
          });
        }

        // Handle OR conditions
        if (options.orWhere && options.orWhere.length > 0) {
          const orFilters = options.orWhere.map((orGroup) =>
            filterAnd(
              ...orGroup.map((w) =>
                filterWhere(String(w.field), w.operator, w.value)
              )
            )
          );
          constraints.push(filterOr(...orFilters));
        }

        if (options.orderBy) {
          options.orderBy.forEach((o) => {
            constraints.push(orderBy(String(o.field), o.direction || "asc"));
          });
        }

        if (options.limit) {
          constraints.push(limit(options.limit));
        }

        const q = query(collectionRef, ...constraints);
        const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
        return snapshot.docs.map((doc) => ({ ...doc.data() }));
      };
    });

    // Add generic query.by method
    queryMethods.by = async (options: QueryOptions): Promise<any[]> => {
      const constraints: any[] = [];

      if (options.where) {
        options.where.forEach((w) => {
          constraints.push(where(String(w.field), w.operator, w.value));
        });
      }

      // Gestion des conditions OR
      if (options.orWhere && options.orWhere.length > 0) {
        const orFilters = options.orWhere.map((orGroup) =>
          filterAnd(
            ...orGroup.map((w) =>
              filterWhere(String(w.field), w.operator, w.value)
            )
          )
        );
        constraints.push(filterOr(...orFilters));
      }

      if (options.orderBy) {
        options.orderBy.forEach((o) => {
          constraints.push(orderBy(String(o.field), o.direction || "asc"));
        });
      }

      if (options.limit) {
        constraints.push(limit(options.limit));
      }

      const q = query(collectionRef, ...constraints);
      const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
      return snapshot.docs.map((doc) => ({ ...doc.data() }));
    };

    // Update method that uses documentRef and returns the merged object
    const update = async (...args: any[]): Promise<any> => {
      const data = args.pop(); // Last argument is always the data
      const pathArgs = args; // Rest are path arguments

      const docRef = documentRef(...pathArgs);
      await updateDoc(docRef, data);

      // Fetch and return the updated object
      const updatedDoc = await getDoc(docRef);
      return updatedDoc.data();
    };

    // Batch methods for atomic operations
    const batchMethods = {
      create: () => {
        const batch = writeBatch(db);
        return {
          batch,
          set: (
            docRef: DocumentReference<DocumentData>,
            data: any,
            merge = true
          ) => {
            batch.set(docRef, data, { merge });
          },
          update: (docRef: DocumentReference<DocumentData>, data: any) => {
            batch.update(docRef, data);
          },
          delete: (docRef: DocumentReference<DocumentData>) => {
            batch.delete(docRef);
          },
          commit: async () => {
            await batch.commit();
          },
        };
      },
    };

    // Bulk methods for processing large quantities (max 500 per batch)
    const bulkMethods = {
      set: async (
        items: Array<{
          docRef: DocumentReference<DocumentData>;
          data: any;
          merge?: boolean;
        }>
      ) => {
        const chunks = chunkArray(items, 500); // Firestore limits batches to 500 operations

        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach(({ docRef, data, merge = true }) => {
            batch.set(docRef, data, { merge });
          });
          await batch.commit();
        }
      },

      update: async (
        items: Array<{ docRef: DocumentReference<DocumentData>; data: any }>
      ) => {
        const chunks = chunkArray(items, 500);

        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach(({ docRef, data }) => {
            batch.update(docRef, data);
          });
          await batch.commit();
        }
      },

      delete: async (docRefs: DocumentReference<DocumentData>[]) => {
        const chunks = chunkArray(docRefs, 500);

        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach((docRef) => {
            batch.delete(docRef);
          });
          await batch.commit();
        }
      },
    };

    return {
      ref: collectionRef,
      documentRef,
      update,
      get: getMethods,
      query: queryMethods,
      batch: batchMethods,
      bulk: bulkMethods,
    } as unknown as ConfiguredRepository<T[K]>;
  }
}

/**
 * Helper function to create a RepositoryMapping instance with full typing
 * @template T - Record of repository configurations
 * @param mapping - Repository configurations
 * @returns RepositoryMapping instance with repository access via getters
 * @example
 * ```typescript
 * const repos = createRepositoryMapping({
 *   users: createRepositoryConfig({
 *     path: "users",
 *     isGroup: false,
 *     foreignKeys: ["docId", "email"] as const,
 *     queryKeys: ["isActive"] as const,
 *     type: {} as UserModel,
 *     refCb: (db, docId: string) => doc(db, "users", docId),
 *   }),
 * });
 *
 * // Access repositories directly
 * const user = await repos.users.get.byDocId("123");
 * ```
 */
export function createRepositoryMapping<T extends Record<string, any>>(
  mapping: T
): RepositoryMapping<T> & { [K in keyof T]: ConfiguredRepository<T[K]> } {
  const instance = new RepositoryMapping(mapping);

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
