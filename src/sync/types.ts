/**
 * Types and interfaces for the Firestore → SQL sync module.
 *
 * This module defines the contract between the sync engine (triggers, queue,
 * worker) and any SQL backend (BigQuery, PostgreSQL, …). Only the adapter
 * touches the database SDK; everything else works with these abstractions.
 */

// ---------------------------------------------------------------------------
// SQL column / dialect
// ---------------------------------------------------------------------------

/** A single column in a SQL table. */
export interface SqlColumn {
  /** Column name (snake_case recommended for SQL) */
  name: string;
  /** SQL type string as understood by the target dialect (e.g. "STRING", "FLOAT64") */
  sqlType: string;
  /** Whether the column accepts NULL values */
  nullable: boolean;
  /** Whether this column is (part of) the primary key */
  isPrimaryKey: boolean;
  /** Optional description / comment */
  description?: string;
}

/** A SQL table definition derived from a Firestore repository schema. */
export interface SqlTableDef {
  /** Table name in the target database */
  tableName: string;
  /** Ordered list of columns */
  columns: SqlColumn[];
}

/**
 * Abstract mapping from logical types to SQL type strings.
 * Each adapter provides a concrete dialect (e.g. BigQuery, PostgreSQL).
 */
export interface SqlDialect {
  /** Human-readable dialect name */
  name: string;
  /** Map a logical type to a concrete SQL type string */
  mapType(logical: LogicalType): string;
  /** Wrap an identifier (table / column name) for the dialect */
  quoteIdentifier(id: string): string;
  /** Generate a full CREATE TABLE statement */
  createTableDDL(table: SqlTableDef): string;
  /** Generate ALTER TABLE ADD COLUMN statement(s) for new columns */
  addColumnsDDL(tableName: string, columns: SqlColumn[]): string;
}

/**
 * Logical types used as an intermediate representation between Zod types
 * and dialect-specific SQL types.
 */
export type LogicalType =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "timestamp"
  | "json"
  | "text";

// ---------------------------------------------------------------------------
// Sync events
// ---------------------------------------------------------------------------

/** Operations that can be synced to SQL. */
export type SyncOperation = "INSERT" | "UPSERT" | "DELETE";

/** A single sync event produced by a Firestore trigger and consumed by the worker. */
export interface SyncEvent {
  /** Which operation to apply */
  operation: SyncOperation;
  /** Repository name (key in the repositoryMapping object) */
  repoName: string;
  /** Document ID (value of documentKey) */
  docId: string;
  /** Serialized document data (null for DELETE) */
  data: Record<string, unknown> | null;
  /** ISO-8601 timestamp of the event */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// SQL adapter
// ---------------------------------------------------------------------------

/**
 * Abstract SQL adapter that the sync worker calls.
 * Each target database provides a concrete implementation.
 */
export interface SqlAdapter {
  /** The SQL dialect used by this adapter */
  readonly dialect: SqlDialect;

  /**
   * Check whether a table exists.
   */
  tableExists(tableName: string): Promise<boolean>;

  /**
   * Return the column names currently present in the table.
   * Used by the migration manager to detect schema drift.
   */
  getTableColumns(tableName: string): Promise<string[]>;

  /**
   * Create a table. Should be idempotent (IF NOT EXISTS).
   */
  createTable(table: SqlTableDef): Promise<void>;

  /**
   * Insert rows (append-only, no dedup).
   */
  insertRows(
    tableName: string,
    rows: Record<string, unknown>[],
  ): Promise<void>;

  /**
   * Upsert rows (INSERT … ON CONFLICT UPDATE / MERGE).
   * `primaryKey` identifies the column(s) used for matching.
   */
  upsertRows(
    tableName: string,
    rows: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void>;

  /**
   * Delete rows by primary-key values.
   */
  deleteRows(
    tableName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-repo sync config
// ---------------------------------------------------------------------------

/** Per-repository sync options, typed to the repo's field names. */
export interface RepoSyncConfig<F extends string = string> {
  /** Override the SQL table name (default: repo name) */
  tableName?: string;
  /** Fields to exclude from the SQL table */
  exclude?: F[];
  /** Field name overrides: Zod field → SQL column name */
  columnMap?: Partial<Record<F, string>>;
  /**
   * Explicit Firestore document path pattern for triggers.
   * **Required** for collection-group repos (`isGroup: true`) because their
   * path cannot be auto-detected.
   * @example "posts/{postId}/comments/{docId}"
   */
  triggerPath?: string;
}

/**
 * Extract field names from a repo value.
 * Works with ConfiguredRepository (_modelType), raw config (schema.shape), or fallback (type).
 */
export type ExtractRepoFields<R> =
  R extends { _modelType: infer Model }
    ? string & keyof Model
    : R extends { schema: { shape: infer S } }
      ? string & keyof S
      : R extends { type: infer T }
        ? string & keyof T
        : string;

/** Keys of repos where `_isGroup` is `true`. */
type GroupRepoKeys<M> = {
  [K in string & keyof M]: M[K] extends { _isGroup: true } ? K : never;
}[string & keyof M];

/** Keys of repos where `_isGroup` is NOT `true`. */
type NonGroupRepoKeys<M> = Exclude<string & keyof M, GroupRepoKeys<M>>;

/**
 * Typed per-repo sync config map.
 * - Collection-group repos (`isGroup: true`): entry is **required** and
 *   `triggerPath` is mandatory.
 * - Regular repos: entry is optional, all fields optional.
 */
export type TypedRepoSyncConfigs<M> = {
  [K in GroupRepoKeys<M>]: RepoSyncConfig<ExtractRepoFields<M[K]>> & {
    triggerPath: string;
  };
} & {
  [K in NonGroupRepoKeys<M>]?: RepoSyncConfig<ExtractRepoFields<M[K]>>;
};

// ---------------------------------------------------------------------------
// External dependencies (injected by the consumer)
// ---------------------------------------------------------------------------

/** Firestore trigger constructors from `firebase-functions/v2/firestore`. */
export interface FirestoreTriggersDep {
  onDocumentCreated: Function;
  onDocumentUpdated: Function;
  onDocumentDeleted: Function;
}

/** PubSub handler from `firebase-functions/v2/pubsub`. */
export interface PubSubHandlerDep {
  onMessagePublished: Function;
}

/** PubSub client instance (e.g. `new PubSub()`). */
export interface PubSubClientDep {
  topic(name: string): { publishMessage(msg: any): Promise<any> };
}

/** All external deps needed by the sync module. */
export interface SyncDeps {
  /** `firebase-functions/v2/firestore` — trigger constructors */
  firestoreTriggers: FirestoreTriggersDep;
  /** `firebase-functions/v2/pubsub` — PubSub handler */
  pubsubHandler: PubSubHandlerDep;
  /** A PubSub client instance (`new PubSub()` from `@google-cloud/pubsub`) */
  pubsub: PubSubClientDep;
}

// ---------------------------------------------------------------------------
// Top-level configs
// ---------------------------------------------------------------------------

/** Options for `createSyncTriggers()`. */
export interface SyncTriggersConfig<M = Record<string, any>> {
  /** External dependencies — Firestore triggers + PubSub */
  deps: Pick<SyncDeps, "firestoreTriggers" | "pubsub">;
  /** PubSub topic name prefix (topics will be `{prefix}-{repoName}`) */
  topicPrefix?: string;
  /** Per-repo overrides */
  repos?: TypedRepoSyncConfigs<M>;
}

/** Options for `createSyncWorker()`. */
export interface SyncWorkerConfig<M = Record<string, any>> {
  /** External dependencies — PubSub handler + client */
  deps: Pick<SyncDeps, "pubsubHandler" | "pubsub">;
  /** SQL adapter to flush data to */
  adapter: SqlAdapter;
  /** Max rows per flush batch (default: 100) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Auto-create/migrate tables on first event (default: false) */
  autoMigrate?: boolean;
  /** Per-repo overrides */
  repos?: TypedRepoSyncConfigs<M>;
}

/** Options for `generateDDL()`. */
export interface GenerateDDLConfig<M = Record<string, any>> {
  /** Per-repo overrides */
  repos?: TypedRepoSyncConfigs<M>;
}

/** Options for `createFirestoreSync()` — the unified wrapper. */
export interface FirestoreSyncConfig<M = Record<string, any>> {
  /** External dependencies — all Firebase/PubSub modules */
  deps: SyncDeps;
  /** SQL adapter to flush data to */
  adapter: SqlAdapter;
  /** PubSub topic name prefix (topics will be `{prefix}-{repoName}`) */
  topicPrefix?: string;
  /** Max rows per flush batch (default: 100) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Auto-create/migrate tables on first event (default: false) */
  autoMigrate?: boolean;
  /** Per-repo overrides (shared between triggers and worker) */
  repos?: TypedRepoSyncConfigs<M>;
}
