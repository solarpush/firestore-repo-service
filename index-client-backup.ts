// /* eslint-disable @typescript-eslint/no-empty-object-type */

// import {
//   CollectionReference,
//   DocumentReference,
//   QuerySnapshot,
//   WriteBatch,
//   addDoc,
//   collection,
//   collectionGroup,
//   deleteDoc,
//   endAt,
//   endBefore,
//   and as filterAnd,
//   or as filterOr,
//   where as filterWhere,
//   getAggregateFromServer,
//   getCountFromServer,
//   getDoc,
//   getDocs,
//   getFirestore,
//   limit,
//   onSnapshot,
//   orderBy,
//   query,
//   runTransaction,
//   setDoc,
//   startAfter,
//   startAt,
//   updateDoc,
//   where,
//   writeBatch,
//   type AggregateField,
//   type DocumentData,
//   type DocumentSnapshot,
//   type Firestore,
//   type FirestoreError,
//   type Transaction,
//   type Unsubscribe,
//   type WhereFilterOp,
// } from "firebase-admin/firestore";

// /**
//  * Example repository mapping configuration
//  * You must define your own mapping according to your data models
//  *
//  * @example
//  * ```typescript
//  * interface UserModel {
//  *   docId: string;
//  *   email: string;
//  *   name: string;
//  *   createdAt: Date;
//  * }
//  *
//  * const repositoryMapping = {
//  *   users: createRepositoryConfig({
//  *     path: "users",
//  *     isGroup: false,
//  *     foreignKeys: ["docId", "email"] as const,
//  *     queryKeys: ["name"] as const,
//  *     type: {} as UserModel,
//  *     refCb: (db, docId: string) => doc(db, "users", docId),
//  *   }),
//  * } as const;
//  * ```
//  */
// const repositoryMapping = {} as const;

// /**
//  * Extract the documentRef signature from refCb (without the db parameter)
//  * @internal
//  */
// type ExtractDocumentRefSignature<T> = T extends (
//   db: Firestore,
//   ...args: infer P
// ) => DocumentReference<DocumentData>
//   ? (...args: P) => DocumentReference<DocumentData>
//   : never;

// /**
//  * Extract the update signature from refCb
//  * @internal
//  */
// type ExtractUpdateSignature<T, TType> = T extends (
//   db: Firestore,
//   ...args: infer P
// ) => DocumentReference<DocumentData>
//   ? (...args: [...P, Partial<TType>]) => Promise<TType>
//   : never;

// /**
//  * Configuration interface for repositories with strict literal type inference
//  * @template T - The data model type
//  * @template TForeignKeys - Foreign keys used for unique document retrieval (get methods)
//  * @template TQueryKeys - Query keys used for multiple document searches (query methods)
//  * @template TIsGroup - Whether this is a collection group query
//  * @template TRefCb - Callback function signature for creating document references
//  */
// interface RepositoryConfig<
//   T,
//   TForeignKeys extends readonly (keyof T)[],
//   TQueryKeys extends readonly (keyof T)[],
//   TIsGroup extends boolean = boolean,
//   TRefCb = any
// > {
//   /** Firestore collection path */
//   path: string;
//   /** Whether this is a collection group query */
//   isGroup: TIsGroup;
//   /** Keys used for unique document retrieval (generates get.by* methods) */
//   foreignKeys: TForeignKeys;
//   /** Keys used for querying multiple documents (generates query.by* methods) */
//   queryKeys: TQueryKeys;
//   /** Type definition for the data model */
//   type: T;
//   /** Callback to construct document reference */
//   refCb?: TRefCb;
//   /** Exposes the same signature as refCb but without the db parameter */
//   documentRef: TRefCb extends undefined
//     ? TIsGroup extends true
//       ? (...pathSegments: string[]) => DocumentReference<DocumentData>
//       : (docId: string) => DocumentReference<DocumentData>
//     : ExtractDocumentRefSignature<TRefCb>;
//   /** Exposes the same signature as refCb but with data parameter and returns the updated object */
//   update: TRefCb extends undefined
//     ? TIsGroup extends true
//       ? (...args: [...string[], Partial<T>]) => Promise<T>
//       : (docId: string, data: Partial<T>) => Promise<T>
//     : ExtractUpdateSignature<TRefCb, T>;
// }

// /**
//  * Helper to create a typed repository configuration with literal type preservation
//  * @template T - The data model type
//  * @template TForeignKeys - Readonly array of foreign keys
//  * @template TQueryKeys - Readonly array of query keys
//  * @template TIsGroup - Boolean indicating if it's a collection group
//  * @template TRefCb - Type of the reference callback function
//  * @param config - Repository configuration object
//  * @returns Configured repository with typed methods
//  * @example
//  * ```typescript
//  * const usersRepo = createRepositoryConfig({
//  *   path: "users",
//  *   isGroup: false,
//  *   foreignKeys: ["docId", "email"] as const,
//  *   queryKeys: ["isActive"] as const,
//  *   type: {} as UserModel,
//  *   refCb: (db, docId: string) => doc(db, "users", docId),
//  * });
//  * ```
//  */
// export function createRepositoryConfig<
//   T,
//   const TForeignKeys extends readonly (keyof T)[],
//   const TQueryKeys extends readonly (keyof T)[],
//   const TIsGroup extends boolean,
//   TRefCb = undefined
// >(config: {
//   path: string;
//   isGroup: TIsGroup;
//   foreignKeys: TForeignKeys;
//   queryKeys: TQueryKeys;
//   type: T;
//   refCb: TRefCb;
// }): RepositoryConfig<T, TForeignKeys, TQueryKeys, TIsGroup, TRefCb> {
//   // documentRef and update will be created in the class constructor with the actual db instance
//   return {
//     ...config,
//     documentRef: null as any, // Will be replaced in constructor
//     update: null as any, // Will be replaced in constructor
//   };
// }

// /**
//  * Type for a where condition with strict value typing based on the field
//  * @template T - Data model type
//  * @example
//  * ```typescript
//  * const condition: WhereClause<EventModel> = {
//  *   field: 'status',
//  *   operator: '==',
//  *   value: 'signed'
//  * }
//  * ```
//  */
// export type WhereClause<T = any> = {
//   [K in keyof T]: {
//     field: K;
//     operator: WhereFilterOp;
//     value: T[K] | T[K][];
//   };
// }[keyof T];

// /**
//  * Type for composite OR/AND conditions
//  * @template T - Data model type
//  * @deprecated Use QueryOptions with orWhere directly
//  */
// export type CompositeFilter<T = any> = {
//   or?: WhereClause<T>[][];
//   and?: WhereClause<T>[];
// };

// /**
//  * Query options for filtering, sorting and paginating results
//  * @template T - Data model type
//  *
//  * @property {WhereClause<T>[]} [where] - Simple AND conditions
//  * @property {WhereClause<T>[][]} [orWhere] - Composite OR conditions. Each sub-array represents an AND group, and groups are combined with OR
//  * @property {Array<{field: keyof T; direction?: "asc" | "desc"}>} [orderBy] - Sort criteria
//  * @property {number} [limit] - Maximum number of results to return
//  * @property {number} [offset] - Number of results to skip (pagination)
//  *
//  * @example
//  * // Simple search with AND
//  * ```typescript
//  * const options: QueryOptions<EventModel> = {
//  *   where: [
//  *     { field: 'status', operator: '==', value: 'signed' },
//  *     { field: 'dateTime', operator: '>=', value: startDate }
//  *   ],
//  *   orderBy: [{ field: 'dateTime', direction: 'desc' }],
//  *   limit: 10
//  * }
//  * ```
//  *
//  * @example
//  * // Search with OR: (status = 'signed' AND dateTime > date1) OR (status = 'scheduled' AND dateTime > date2)
//  * ```typescript
//  * const options: QueryOptions<EventModel> = {
//  *   orWhere: [
//  *     [
//  *       { field: 'status', operator: '==', value: 'signed' },
//  *       { field: 'dateTime', operator: '>=', value: date1 }
//  *     ],
//  *     [
//  *       { field: 'status', operator: '==', value: 'scheduled' },
//  *       { field: 'dateTime', operator: '>=', value: date2 }
//  *     ]
//  *   ]
//  * }
//  * ```
//  */
// export interface QueryOptions<T = any> {
//   where?: WhereClause<T>[];
//   orWhere?: WhereClause<T>[][];
//   orderBy?: { field: keyof T; direction?: "asc" | "desc" }[];
//   limit?: number;
//   offset?: number;
//   startAt?: DocumentSnapshot<DocumentData> | any[];
//   startAfter?: DocumentSnapshot<DocumentData> | any[];
//   endAt?: DocumentSnapshot<DocumentData> | any[];
//   endBefore?: DocumentSnapshot<DocumentData> | any[];
// }

// /**
//  * Result type for get operations with optional document snapshot
//  * @internal
//  */
// type GetResult<T, ReturnDoc extends boolean> = ReturnDoc extends true
//   ? { data: T; doc: DocumentSnapshot<DocumentData> } | null
//   : T | null;

// /**
//  * Generates get.by* methods from foreign keys
//  * @internal
//  */
// type GenerateGetMethods<TConfig extends RepositoryConfig<any, any, any, any>> =
//   {
//     [K in TConfig["foreignKeys"][number] as K extends string
//       ? `by${Capitalize<K>}`
//       : never]: <ReturnDoc extends boolean = false>(
//       value: TConfig["type"][K],
//       returnDoc?: ReturnDoc
//     ) => Promise<GetResult<TConfig["type"], ReturnDoc>>;
//   };

// /**
//  * Generates query.by* methods from query keys
//  * @internal
//  */
// type GenerateQueryMethods<
//   TConfig extends RepositoryConfig<any, any, any, any>
// > = {
//   [K in TConfig["queryKeys"][number] as K extends string
//     ? `by${Capitalize<K>}`
//     : never]: (
//     value: TConfig["type"][K],
//     options?: QueryOptions<TConfig["type"]>
//   ) => Promise<TConfig["type"][]>;
// };

// /**
//  * Configured repository with organized methods
//  * @internal
//  */
// type ConfiguredRepository<T extends RepositoryConfig<any, any, any, any>> = {
//   /** Firestore collection reference */
//   ref: CollectionReference<DocumentData>;

//   /** Retrieval methods (getBy*) */
//   get: GenerateGetMethods<T> & {
//     /** Retrieves multiple documents by a list of values for a given key */
//     byList: <K extends keyof T["type"], ReturnDoc extends boolean = false>(
//       key: K,
//       values: T["type"][K][],
//       operator?: "in" | "array-contains-any",
//       returnDoc?: ReturnDoc
//     ) => Promise<
//       ReturnDoc extends true
//         ? Array<{
//             data: T["type"];
//             doc: DocumentSnapshot<DocumentData>;
//           }>
//         : T["type"][]
//     >;
//   };

//   /** Query methods (queryBy*) */
//   query: GenerateQueryMethods<T> & {
//     by: (options: QueryOptions<T["type"]>) => Promise<T["type"][]>;
//     getAll: (options?: QueryOptions<T["type"]>) => Promise<T["type"][]>;
//     onSnapshot: (
//       options: QueryOptions<T["type"]>,
//       onNext: (data: T["type"][]) => void,
//       onError?: (error: FirestoreError) => void
//     ) => Unsubscribe;
//   };

//   /** Aggregate methods for server-side computations */
//   aggregate: {
//     /**
//      * Gets the count of documents matching the query options
//      * @param options - Optional query options to filter documents
//      * @returns Promise with the count of documents
//      * @example
//      * ```typescript
//      * const count = await repos.users.aggregate.count();
//      * const activeCount = await repos.users.aggregate.count({
//      *   where: [{ field: 'isActive', operator: '==', value: true }]
//      * });
//      * ```
//      */
//     count: (options?: QueryOptions<T["type"]>) => Promise<number>;

//     /**
//      * Performs custom aggregate queries (count, sum, average)
//      * @param aggregateSpec - Specification of aggregations to perform
//      * @param options - Optional query options to filter documents
//      * @returns Promise with aggregate results
//      * @example
//      * ```typescript
//      * const result = await repos.users.aggregate.query(
//      *   { totalUsers: count(), avgAge: average('age'), totalBalance: sum('balance') },
//      *   { where: [{ field: 'isActive', operator: '==', value: true }] }
//      * );
//      * console.log(result); // { totalUsers: 150, avgAge: 32.5, totalBalance: 50000 }
//      * ```
//      */
//     query: <T extends Record<string, AggregateField<any>>>(
//       aggregateSpec: T,
//       options?: QueryOptions<T["type"]>
//     ) => Promise<{
//       [K in keyof T]: T[K] extends AggregateField<infer U> ? U : never;
//     }>;
//   };

//   /** Method to get a document reference */
//   documentRef: T["documentRef"];

//   /**
//    * Creates a new document with auto-generated ID
//    * @param data - Document data
//    * @returns Promise with the created document including its generated ID
//    */
//   create: (data: Partial<T["type"]>) => Promise<T["type"] & { docId: string }>;

//   /**
//    * Sets a document (creates or replaces)
//    * @param args - Path arguments followed by data and optional merge option
//    * @returns Promise with the set document
//    */
//   set: (
//     ...args: [
//       ...Parameters<T["documentRef"]>,
//       Partial<T["type"]>,
//       { merge?: boolean }?
//     ]
//   ) => Promise<T["type"]>;

//   /** Updates a document and returns the updated data */
//   update: T["update"];

//   /**
//    * Deletes a document
//    * @param args - Path arguments for the document to delete
//    * @returns Promise that resolves when deletion is complete
//    */
//   delete: (...args: Parameters<T["documentRef"]>) => Promise<void>;

//   /** Batch operations for atomic transactions */
//   batch: {
//     /** Creates a batch for atomic operations */
//     create: () => {
//       batch: WriteBatch;
//       set: (
//         docRef: DocumentReference<DocumentData>,
//         data: Partial<T["type"]>,
//         merge?: boolean
//       ) => void;
//       update: (
//         docRef: DocumentReference<DocumentData>,
//         data: Partial<T["type"]>
//       ) => void;
//       delete: (docRef: DocumentReference<DocumentData>) => void;
//       commit: () => Promise<void>;
//     };
//   };

//   /** Transaction operations for atomic read-write operations */
//   transaction: {
//     /**
//      * Runs a transaction with type-safe read and write operations
//      * @param updateFunction - Function that receives a typed transaction wrapper
//      * @returns Promise that resolves with the transaction result
//      * @example
//      * ```typescript
//      * await repos.users.transaction.run(async (txn) => {
//      *   const user = await txn.get("user123");
//      *   if (user) {
//      *     await txn.update("user123", { balance: user.balance + 100 });
//      *   }
//      * });
//      * ```
//      */
//     run: <R>(
//       updateFunction: (transaction: {
//         /** Get a document by its reference (type-safe) */
//         get: (
//           ...args: Parameters<T["documentRef"]>
//         ) => Promise<T["type"] | null>;
//         /** Set a document (type-safe) */
//         set: (
//           ...args: [
//             ...Parameters<T["documentRef"]>,
//             Partial<T["type"]>,
//             { merge?: boolean }?
//           ]
//         ) => void;
//         /** Update a document (type-safe) */
//         update: (
//           ...args: [...Parameters<T["documentRef"]>, Partial<T["type"]>]
//         ) => void;
//         /** Delete a document */
//         delete: (...args: Parameters<T["documentRef"]>) => void;
//         /** Access raw Firestore transaction if needed */
//         raw: Transaction;
//       }) => Promise<R>
//     ) => Promise<R>;
//   };

//   /** Bulk operations for processing large quantities */
//   bulk: {
//     /** Creates/updates multiple documents (automatically divided into batches of 500) */
//     set: (
//       items: Array<{
//         docRef: DocumentReference<DocumentData>;
//         data: Partial<T["type"]>;
//         merge?: boolean;
//       }>
//     ) => Promise<void>;

//     /** Updates multiple documents (automatically divided into batches of 500) */
//     update: (
//       items: Array<{
//         docRef: DocumentReference<DocumentData>;
//         data: Partial<T["type"]>;
//       }>
//     ) => Promise<void>;

//     /** Deletes multiple documents (automatically divided into batches of 500) */
//     delete: (docRefs: DocumentReference<DocumentData>[]) => Promise<void>;
//   };
// };

// /**
//  * Repository mapping class that manages Firestore repositories with type safety
//  * @template T - Record of repository configurations
//  */
// export class RepositoryMapping<
//   T extends Record<string, any> = typeof repositoryMapping
// > {
//   private db?: Firestore;
//   private repositoryCache = new Map<string, any>();
//   private mapping: T;

//   /**
//    * Creates a new RepositoryMapping instance
//    * @param mapping - Repository configuration mapping
//    */
//   constructor(mapping: T) {
//     this.mapping = mapping;
//   }

//   /**
//    * Initializes and returns the Firestore instance
//    * @private
//    * @returns Firestore instance
//    */
//   private init(): Firestore {
//     if (!this.db) {
//       this.db = getFirestore();
//     }
//     return this.db;
//   }

//   /**
//    * Gets a repository with lazy loading
//    * @template K - Repository key
//    * @param key - Repository identifier
//    * @returns Configured repository instance
//    */
//   getRepository<K extends keyof T>(key: K): ConfiguredRepository<T[K]> {
//     if (!this.repositoryCache.has(key as string)) {
//       this.repositoryCache.set(key as string, this.createRepository(key));
//     }
//     return this.repositoryCache.get(key as string)!;
//   }

//   // Getters are automatically generated via a Proxy (see createRepositoryMapping)

//   /**
//    * Creates a configured repository instance
//    * @private
//    * @template K - Repository key
//    * @param key - Repository identifier
//    * @returns Configured repository with all methods
//    */
//   private createRepository<K extends keyof T>(
//     key: K
//   ): ConfiguredRepository<T[K]> {
//     const db = this.init();
//     const element = this.mapping[key];
//     const collectionRef = element.isGroup
//       ? collectionGroup(db, element.path)
//       : collection(db, element.path);

//     // Keep a reference to the actual collection for create operations
//     const actualCollection = element.isGroup
//       ? null
//       : collection(db, element.path);

//     const getMethods: any = {};
//     const queryMethods: any = {};

//     // Create the documentRef method with the db instance
//     const documentRef = (...args: any[]) => (element.refCb as any)(db, ...args);

//     // Helper to split an array into chunks
//     const chunkArray = <T>(array: T[], size: number): T[][] => {
//       const chunks: T[][] = [];
//       for (let i = 0; i < array.length; i += size) {
//         chunks.push(array.slice(i, i + size));
//       }
//       return chunks;
//     };

//     // Add get.byList method to retrieve by batches
//     getMethods.byList = async (
//       key: string,
//       values: any[],
//       operator: "in" | "array-contains-any" = "in",
//       returnDoc = false
//     ): Promise<any[]> => {
//       if (values.length === 0) return [];

//       const results: any[] = [];
//       const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

//       for (const chunk of chunks) {
//         const q = query(collectionRef, where(key, operator, chunk));
//         const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);

//         snapshot.forEach((doc) => {
//           results.push(
//             returnDoc ? { data: doc.data(), doc } : { ...doc.data() }
//           );
//         });
//       }

//       return results;
//     };

//     // Generate ONLY get.by* methods for defined foreignKeys
//     element.foreignKeys.forEach((foreignKey: string) => {
//       const capitalizedKey =
//         String(foreignKey).charAt(0).toUpperCase() +
//         String(foreignKey).slice(1);
//       const getMethodName = `by${capitalizedKey}`;
//       getMethods[getMethodName] = async (
//         value: string,
//         returnDoc = false
//       ): Promise<any | null> => {
//         const q = query(
//           collectionRef,
//           where(String(foreignKey), "==", value),
//           limit(1)
//         );
//         const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
//         if (snapshot.empty) return null;
//         const doc = snapshot.docs[0];
//         if (!doc) return null;
//         return returnDoc ? { data: doc.data(), doc } : { ...doc.data() };
//       };
//     });

//     // Generate ONLY query.by* methods for defined queryKeys
//     element.queryKeys.forEach((queryKey: string) => {
//       const capitalizedKey =
//         String(queryKey).charAt(0).toUpperCase() + String(queryKey).slice(1);
//       const queryMethodName = `by${capitalizedKey}`;
//       queryMethods[queryMethodName] = async (
//         value: string,
//         options: QueryOptions = {}
//       ): Promise<any[]> => {
//         const baseConstraint = [where(String(queryKey), "==", value)];
//         const additionalConstraints = buildQueryConstraints(options);
//         const allConstraints = [...baseConstraint, ...additionalConstraints];

//         const q = query(collectionRef, ...allConstraints);
//         const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
//         return snapshot.docs.map((doc) => ({ ...doc.data() }));
//       };
//     });

//     // Helper function to build query constraints from options
//     const buildQueryConstraints = (options: QueryOptions): any[] => {
//       const constraints: any[] = [];

//       if (options.where) {
//         options.where.forEach((w) => {
//           constraints.push(where(String(w.field), w.operator, w.value));
//         });
//       }

//       // Handle OR conditions
//       if (options.orWhere && options.orWhere.length > 0) {
//         const orFilters = options.orWhere.map((orGroup) =>
//           filterAnd(
//             ...orGroup.map((w) =>
//               filterWhere(String(w.field), w.operator, w.value)
//             )
//           )
//         );
//         constraints.push(filterOr(...orFilters));
//       }

//       if (options.orderBy) {
//         options.orderBy.forEach((o) => {
//           constraints.push(orderBy(String(o.field), o.direction || "asc"));
//         });
//       }

//       if (options.limit) {
//         constraints.push(limit(options.limit));
//       }

//       // Cursor-based pagination
//       if (options.startAt) {
//         constraints.push(
//           Array.isArray(options.startAt)
//             ? startAt(...options.startAt)
//             : startAt(options.startAt)
//         );
//       }

//       if (options.startAfter) {
//         constraints.push(
//           Array.isArray(options.startAfter)
//             ? startAfter(...options.startAfter)
//             : startAfter(options.startAfter)
//         );
//       }

//       if (options.endAt) {
//         constraints.push(
//           Array.isArray(options.endAt)
//             ? endAt(...options.endAt)
//             : endAt(options.endAt)
//         );
//       }

//       if (options.endBefore) {
//         constraints.push(
//           Array.isArray(options.endBefore)
//             ? endBefore(...options.endBefore)
//             : endBefore(options.endBefore)
//         );
//       }

//       return constraints;
//     };

//     // Add generic query.by method
//     queryMethods.by = async (options: QueryOptions): Promise<any[]> => {
//       const constraints = buildQueryConstraints(options);
//       const q = query(collectionRef, ...constraints);
//       const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
//       return snapshot.docs.map((doc) => ({ ...doc.data() }));
//     };

//     // Add getAll method to retrieve all documents from the collection
//     queryMethods.getAll = async (
//       options: QueryOptions = {}
//     ): Promise<any[]> => {
//       const constraints = buildQueryConstraints(options);
//       const q =
//         constraints.length > 0
//           ? query(collectionRef, ...constraints)
//           : collectionRef;
//       const snapshot: QuerySnapshot<DocumentData> = await getDocs(q);
//       return snapshot.docs.map((doc) => ({ ...doc.data() }));
//     };

//     // Add onSnapshot method for real-time listeners
//     queryMethods.onSnapshot = (
//       options: QueryOptions,
//       onNext: (data: any[]) => void,
//       onError?: (error: FirestoreError) => void
//     ): Unsubscribe => {
//       const constraints = buildQueryConstraints(options);
//       const q = query(collectionRef, ...constraints);

//       return onSnapshot(
//         q,
//         (snapshot) => {
//           const data = snapshot.docs.map((doc) => ({ ...doc.data() }));
//           onNext(data);
//         },
//         onError
//       );
//     };

//     // Aggregate methods for server-side computations
//     const aggregateMethods = {
//       // Count documents matching query options
//       count: async (options: QueryOptions = {}): Promise<number> => {
//         const constraints = buildQueryConstraints(options);
//         const q =
//           constraints.length > 0
//             ? query(collectionRef, ...constraints)
//             : collectionRef;

//         const snapshot = await getCountFromServer(q);
//         return snapshot.data().count;
//       },

//       // Custom aggregate query (count, sum, average)
//       query: async (
//         aggregateSpec: any,
//         options: QueryOptions = {}
//       ): Promise<any> => {
//         const constraints = buildQueryConstraints(options);
//         const q =
//           constraints.length > 0
//             ? query(collectionRef, ...constraints)
//             : collectionRef;

//         const snapshot = await getAggregateFromServer(q, aggregateSpec);
//         return snapshot.data();
//       },
//     };

//     // Create method - adds a new document with auto-generated ID
//     const create = async (data: any): Promise<any> => {
//       if (!actualCollection) {
//         throw new Error(
//           "Cannot use create() on collection groups. Use set() with a specific document ID instead."
//         );
//       }
//       const docRef = await addDoc(actualCollection, data);
//       const createdDoc = await getDoc(docRef);
//       return { ...createdDoc.data(), docId: docRef.id };
//     };

//     // Set method - creates or replaces a document
//     const set = async (...args: any[]): Promise<any> => {
//       const lastArg = args[args.length - 1];
//       const hasOptions =
//         typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

//       const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
//       const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
//       const mergeOption = hasOptions ? lastArg : { merge: true };

//       const docRef = documentRef(...pathArgs);
//       await setDoc(docRef, data, mergeOption);

//       // Fetch and return the set document
//       const setDocument = await getDoc(docRef);
//       return setDocument.data();
//     };

//     // Update method that uses documentRef and returns the merged object
//     const update = async (...args: any[]): Promise<any> => {
//       const data = args.pop(); // Last argument is always the data
//       const pathArgs = args; // Rest are path arguments

//       const docRef = documentRef(...pathArgs);
//       await updateDoc(docRef, data);

//       // Fetch and return the updated object
//       const updatedDoc = await getDoc(docRef);
//       return updatedDoc.data();
//     };

//     // Delete method - removes a document
//     const deleteMethod = async (...args: any[]): Promise<void> => {
//       const docRef = documentRef(...args);
//       await deleteDoc(docRef);
//     };

//     // Batch methods for atomic operations
//     const batchMethods = {
//       create: () => {
//         const batch = writeBatch(db);
//         return {
//           batch,
//           set: (
//             docRef: DocumentReference<DocumentData>,
//             data: any,
//             merge = true
//           ) => {
//             batch.set(docRef, data, { merge });
//           },
//           update: (docRef: DocumentReference<DocumentData>, data: any) => {
//             batch.update(docRef, data);
//           },
//           delete: (docRef: DocumentReference<DocumentData>) => {
//             batch.delete(docRef);
//           },
//           commit: async () => {
//             await batch.commit();
//           },
//         };
//       },
//     };

//     // Transaction methods for atomic read-write operations
//     const transactionMethods = {
//       run: async <R>(
//         updateFunction: (transaction: any) => Promise<R>
//       ): Promise<R> => {
//         return runTransaction(db, async (rawTransaction) => {
//           // Create a typed transaction wrapper
//           const typedTransaction = {
//             // Type-safe get method
//             get: async (...args: any[]) => {
//               const docRef = documentRef(...args);
//               const docSnap = await rawTransaction.get(docRef);
//               if (!docSnap.exists()) return null;
//               return docSnap.data() as any;
//             },

//             // Type-safe set method
//             set: (...args: any[]) => {
//               const options = args[args.length - 1];
//               const hasOptions =
//                 typeof options === "object" &&
//                 options !== null &&
//                 "merge" in options;

//               const data = hasOptions
//                 ? args[args.length - 2]
//                 : args[args.length - 1];
//               const pathArgs = hasOptions
//                 ? args.slice(0, -2)
//                 : args.slice(0, -1);
//               const mergeOption = hasOptions ? options : { merge: true };

//               const docRef = documentRef(...pathArgs);
//               rawTransaction.set(docRef, data, mergeOption);
//             },

//             // Type-safe update method
//             update: (...args: any[]) => {
//               const data = args[args.length - 1];
//               const pathArgs = args.slice(0, -1);
//               const docRef = documentRef(...pathArgs);
//               rawTransaction.update(docRef, data);
//             },

//             // Delete method
//             delete: (...args: any[]) => {
//               const docRef = documentRef(...args);
//               rawTransaction.delete(docRef);
//             },

//             // Access to raw transaction if needed
//             raw: rawTransaction,
//           };

//           return updateFunction(typedTransaction);
//         });
//       },
//     };

//     // Bulk methods for processing large quantities (max 500 per batch)
//     const bulkMethods = {
//       set: async (
//         items: Array<{
//           docRef: DocumentReference<DocumentData>;
//           data: any;
//           merge?: boolean;
//         }>
//       ) => {
//         const chunks = chunkArray(items, 500); // Firestore limits batches to 500 operations

//         for (const chunk of chunks) {
//           const batch = writeBatch(db);
//           chunk.forEach(({ docRef, data, merge = true }) => {
//             batch.set(docRef, data, { merge });
//           });
//           await batch.commit();
//         }
//       },

//       update: async (
//         items: Array<{ docRef: DocumentReference<DocumentData>; data: any }>
//       ) => {
//         const chunks = chunkArray(items, 500);

//         for (const chunk of chunks) {
//           const batch = writeBatch(db);
//           chunk.forEach(({ docRef, data }) => {
//             batch.update(docRef, data);
//           });
//           await batch.commit();
//         }
//       },

//       delete: async (docRefs: DocumentReference<DocumentData>[]) => {
//         const chunks = chunkArray(docRefs, 500);

//         for (const chunk of chunks) {
//           const batch = writeBatch(db);
//           chunk.forEach((docRef) => {
//             batch.delete(docRef);
//           });
//           await batch.commit();
//         }
//       },
//     };

//     return {
//       ref: collectionRef,
//       documentRef,
//       create,
//       set,
//       update,
//       delete: deleteMethod,
//       get: getMethods,
//       query: queryMethods,
//       aggregate: aggregateMethods,
//       batch: batchMethods,
//       transaction: transactionMethods,
//       bulk: bulkMethods,
//     } as unknown as ConfiguredRepository<T[K]>;
//   }
// }

// /**
//  * Helper function to create a RepositoryMapping instance with full typing
//  * @template T - Record of repository configurations
//  * @param mapping - Repository configurations
//  * @returns RepositoryMapping instance with repository access via getters
//  * @example
//  * ```typescript
//  * const repos = createRepositoryMapping({
//  *   users: createRepositoryConfig({
//  *     path: "users",
//  *     isGroup: false,
//  *     foreignKeys: ["docId", "email"] as const,
//  *     queryKeys: ["isActive"] as const,
//  *     type: {} as UserModel,
//  *     refCb: (db, docId: string) => doc(db, "users", docId),
//  *   }),
//  * });
//  *
//  * // Access repositories directly
//  * const user = await repos.users.get.byDocId("123");
//  * ```
//  */
// export function createRepositoryMapping<T extends Record<string, any>>(
//   mapping: T
// ): RepositoryMapping<T> & { [K in keyof T]: ConfiguredRepository<T[K]> } {
//   const instance = new RepositoryMapping(mapping);

//   // Create a Proxy to dynamically generate getters
//   return new Proxy(instance, {
//     get(target, prop) {
//       if (typeof prop === "string" && prop in mapping) {
//         return target.getRepository(prop as keyof T);
//       }
//       return (target as any)[prop];
//     },
//   }) as any;
// }

// // Re-export aggregate functions for convenience
// export { average, count, sum } from "firebase/firestore";
