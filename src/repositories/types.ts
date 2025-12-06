import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  Transaction,
  WriteBatch,
} from "firebase-admin/firestore";
import type {
  createPaginationIterator,
  executePaginatedQuery,
  PaginationOptions,
} from "../pagination";
import type {
  GetResult,
  QueryOptions,
  RelationConfig,
  RepositoryConfig,
} from "../shared/types";

/**
 * Helper type to get the system keys (documentKey + pathKey) that should be excluded from updates
 * @internal
 */
type SystemKeys<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any>
> =
  | T["documentKey"]
  | (T["pathKey"] extends undefined
      ? never
      : T["pathKey"] extends keyof T["type"]
      ? T["pathKey"]
      : never);

/**
 * Type for updatable data - excludes documentKey and pathKey
 * @internal
 */
type UpdatableData<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any>
> = Omit<Partial<T["type"]>, SystemKeys<T>>;

/**
 * Type for create data - all fields required except documentKey (optional) and pathKey (excluded)
 * @internal
 */
type CreateData<
  T extends RepositoryConfig<any, any, any, any, any, any, any, any>
> = Omit<
  T["type"],
  T["documentKey"] | Extract<T["pathKey"], keyof T["type"]>
> & {
  [K in T["documentKey"]]?: T["type"][K];
};

/**
 * Helper type to extract populated data structure from a single relation
 * @internal
 */
type ExtractPopulatedFromRelation<TRelation> = TRelation extends RelationConfig<
  infer TRepo,
  any,
  infer TType,
  infer TTargetModel
>
  ? { [P in TRepo]: TType extends "one" ? TTargetModel | null : TTargetModel[] }
  : Record<string, never>;

/**
 * Helper type to merge multiple populated objects into one
 * @internal
 */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never;

/**
 * Generates get.by* methods from foreign keys
 * @internal
 */
export type GenerateGetMethods<
  TConfig extends RepositoryConfig<any, any, any, any, any, any>
> = {
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
export type GenerateQueryMethods<
  TConfig extends RepositoryConfig<any, any, any, any, any, any>
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
 */
export type ConfiguredRepository<
  T extends RepositoryConfig<any, any, any, any, any, any>
> = {
  ref: CollectionReference | Query;

  get: GenerateGetMethods<T> & {
    byList: <K extends keyof T["type"], ReturnDoc extends boolean = false>(
      key: K,
      values: T["type"][K][],
      operator?: "in" | "array-contains-any",
      returnDoc?: ReturnDoc
    ) => Promise<
      ReturnDoc extends true
        ? Array<{ data: T["type"]; doc: DocumentSnapshot }>
        : T["type"][]
    >;
  };

  query: GenerateQueryMethods<T> & {
    by: (options: QueryOptions<T["type"]>) => Promise<T["type"][]>;
    getAll: (options?: QueryOptions<T["type"]>) => Promise<T["type"][]>;
    onSnapshot: (
      options: QueryOptions<T["type"]>,
      onNext: (data: T["type"][]) => void,
      onError?: (error: Error) => void
    ) => () => void;
    paginate: (
      options: PaginationOptions<T["type"]>
    ) => ReturnType<typeof executePaginatedQuery<T["type"]>>;
    paginateAll: (
      options: Omit<PaginationOptions<T["type"]>, "cursor" | "direction">
    ) => ReturnType<typeof createPaginationIterator<T["type"]>>;
  };

  aggregate: {
    count: (options?: QueryOptions<T["type"]>) => Promise<number>;
    sum: <K extends keyof T["type"]>(
      field: K,
      options?: QueryOptions<T["type"]>
    ) => Promise<number>;
    average: <K extends keyof T["type"]>(
      field: K,
      options?: QueryOptions<T["type"]>
    ) => Promise<number | null>;
  };

  documentRef: T["documentRef"];

  create: (data: CreateData<T>) => Promise<T["type"]>;

  set: (
    ...args: [
      ...Parameters<T["documentRef"]>,
      UpdatableData<T>,
      { merge?: boolean }?
    ]
  ) => Promise<T["type"]>;

  update: (
    ...args: [...Parameters<T["documentRef"]>, UpdatableData<T>]
  ) => Promise<T["type"]>;

  delete: (...args: Parameters<T["documentRef"]>) => Promise<void>;

  batch: {
    create: () => {
      batch: WriteBatch;
      set: (
        ...args: [
          ...Parameters<T["documentRef"]>,
          UpdatableData<T>,
          { merge?: boolean }?
        ]
      ) => void;
      update: (
        ...args: [...Parameters<T["documentRef"]>, UpdatableData<T>]
      ) => void;
      delete: (...args: Parameters<T["documentRef"]>) => void;
      commit: () => Promise<void>;
    };
  };

  transaction: {
    run: <R>(
      updateFunction: (transaction: {
        get: (
          ...args: Parameters<T["documentRef"]>
        ) => Promise<T["type"] | null>;
        set: (
          ...args: [
            ...Parameters<T["documentRef"]>,
            UpdatableData<T>,
            { merge?: boolean }?
          ]
        ) => void;
        update: (
          ...args: [...Parameters<T["documentRef"]>, UpdatableData<T>]
        ) => void;
        delete: (...args: Parameters<T["documentRef"]>) => void;
        raw: Transaction;
      }) => Promise<R>
    ) => Promise<R>;
  };

  bulk: {
    set: (
      items: Array<{
        docRef: DocumentReference;
        data: UpdatableData<T>;
        merge?: boolean;
      }>
    ) => Promise<void>;
    update: (
      items: Array<{ docRef: DocumentReference; data: UpdatableData<T> }>
    ) => Promise<void>;
    delete: (docRefs: DocumentReference[]) => Promise<void>;
  };

  populate: <K extends keyof NonNullable<T["relationalKeys"]>>(
    document: T["type"],
    relationKey: K | K[]
  ) => Promise<
    T["type"] & {
      populated: UnionToIntersection<
        K extends keyof NonNullable<T["relationalKeys"]>
          ? ExtractPopulatedFromRelation<NonNullable<T["relationalKeys"]>[K]>
          : Record<string, never>
      >;
    }
  >;
};
