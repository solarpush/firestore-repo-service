/**
 * Types and interfaces for the Firestore → SQL sync module.
 *
 * This module defines the contract between the sync engine (triggers, queue,
 * worker) and any SQL backend (BigQuery, PostgreSQL, …). Only the adapter
 * touches the database SDK; everything else works with these abstractions.
 */

import type {
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import type { HttpsOptions, onRequest } from "firebase-functions/v2/https";
import type {
  PubSubOptions,
  onMessagePublished,
} from "firebase-functions/v2/pubsub";
import type { z } from "zod";

/**
 * Cloud Functions v2 options forwarded to `onMessagePublished()` for every
 * sync worker handler. The `topic` field is omitted because the library sets
 * it itself from `topicPrefix` + repo name.
 */
export type SyncWorkerOptions = Omit<PubSubOptions, "topic">;

/**
 * Cloud Functions v2 options forwarded to `onRequest()` for the admin handler.
 * Re-export of `HttpsOptions` from `firebase-functions/v2/https`.
 */
export type AdminHttpsOptions = HttpsOptions;

// ---------------------------------------------------------------------------
// Lazy factory utility
// ---------------------------------------------------------------------------

/** A value that can be provided directly or as a lazy factory function. */
export type OrFactory<T> = T | (() => T);

// ---------------------------------------------------------------------------
// Sync Adapter & Health Types
// ---------------------------------------------------------------------------

/** Result returned by an adapter's healthCheck method. */
export interface SyncHealthResult {
  /** Overall health status for this target */
  healthy: boolean;
  /** Target table or index name */
  targetName: string;
  /** Whether the target table/index exists */
  targetExists: boolean;
  /** Error message if unhealthy */
  error?: string | null;
  /** Adapter-specific health details (e.g. column mismatch for SQL, doc counts for Search) */
  details?: Record<string, unknown>;
}

/**
 * Universal adapter interface that the sync worker and admin dashboard call.
 * Implementations exist for BigQuery, Meilisearch, and can be written for
 * PostgreSQL, Elasticsearch, Typesense, etc.
 */
export interface SyncAdapter {
  /** Unique adapter identifier, e.g. "bigquery", "meilisearch", "postgres" */
  readonly name: string;

  /** Check whether the target storage (table, index, etc.) exists */
  targetExists(targetName: string): Promise<boolean>;

  /**
   * Upsert rows/documents into target storage.
   * @param targetName - SQL table name or Search index UID
   * @param items - Serialized rows / documents
   * @param primaryKey - Column or field name used as primary key
   */
  upsert(
    targetName: string,
    items: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void>;

  /**
   * Delete rows/documents by primary key IDs.
   * @param targetName - SQL table name or Search index UID
   * @param primaryKey - Column or field name used as primary key
   * @param ids - Array of document / row IDs to delete
   */
  delete(
    targetName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void>;

  /**
   * Optional: prepare/migrate target schema or create target if missing.
   * For SQL: creates table and adds missing columns.
   * For Meilisearch: creates index and configures filterable/sortable attributes.
   */
  ensureTarget?(options: {
    targetName: string;
    primaryKey: string;
    schema?: z.ZodObject<any>;
    exclude?: string[];
    columnMap?: Record<string, string>;
  }): Promise<void>;

  /**
   * Optional: custom health check for the admin dashboard.
   */
  healthCheck?(options: {
    targetName: string;
    primaryKey: string;
    schema?: z.ZodObject<any>;
    repoConfig?: RepoSyncConfig<string>;
  }): Promise<SyncHealthResult>;
}

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

/** Operations that can be synced to target storage. */
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
  /**
   * Monotonic version (publish-time `Date.now()` in ms). Used by the worker
   * to apply only the most recent event per document and to discard
   * out-of-order PubSub deliveries — a stale event with a smaller `version`
   * than the row already in SQL is skipped at MERGE time.
   *
   * Optional for backwards-compat with events published by older library
   * versions; the worker treats `undefined` as "always apply".
   */
  version?: number;
  /**
   * DLQ retry bookkeeping. Set by the worker when an event is re-published to
   * the dead-letter topic after a flush failure. Used to cap retries of a
   * poison message (see issue #09). Absent on first-time events.
   */
  attempts?: number;
  /** Epoch millis of the first flush failure for this event (DLQ only). */
  firstFailedAt?: number;
}

// ---------------------------------------------------------------------------
// SQL adapter (extends SyncAdapter)
// ---------------------------------------------------------------------------

/**
 * Abstract SQL adapter that the sync worker calls.
 * Extends the universal {@link SyncAdapter}.
 */
export interface SqlAdapter extends SyncAdapter {
  /** The SQL dialect used by this adapter */
  readonly dialect: SqlDialect;

  /** Check whether a table exists. */
  tableExists(tableName: string): Promise<boolean>;

  /**
   * Return the column names currently present in the table.
   * Used by the migration manager to detect schema drift.
   */
  getTableColumns(tableName: string): Promise<string[]>;

  /**
   * Return existing columns with their dialect-specific SQL type strings.
   * Used by the worker to detect type drift (e.g. Zod field changes from
   * `number` to `string`) and fail fast with an explicit error rather than
   * letting MERGE/Storage Write fail silently on every event.
   *
   * Optional: if the adapter does not implement it,
   * the worker skips type-drift detection but still adds new columns.
   */
  getTableColumnsWithTypes?(
    tableName: string,
  ): Promise<Map<string, string>>;

  /** Create a table. Should be idempotent (IF NOT EXISTS). */
  createTable(table: SqlTableDef): Promise<void>;

  /** Insert rows (append-only, no dedup). */
  insertRows(tableName: string, rows: Record<string, unknown>[]): Promise<void>;

  /**
   * Upsert rows (INSERT … ON CONFLICT UPDATE / MERGE).
   * `primaryKey` identifies the column(s) used for matching.
   */
  upsertRows(
    tableName: string,
    rows: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void>;

  /** Delete rows by primary-key values. */
  deleteRows(
    tableName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void>;

  /**
   * Add columns to an existing table.
   * The adapter is responsible for qualifying table names (e.g. dataset.table).
   */
  addColumns(tableName: string, columns: SqlColumn[]): Promise<void>;

  /**
   * Hook called by the worker after a schema change (`addColumns`) so that
   * adapters caching schema-derived state — e.g. Storage Write proto
   * descriptors / writer connections — can invalidate their cache.
   *
   * Optional: adapters with no cache do not need to implement this.
   */
  onSchemaChange?(tableName: string): void | Promise<void>;

  /**
   * Execute a raw SQL statement.
   * The adapter is responsible for qualifying any table references.
   */
  executeRaw(sql: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-repo sync config
// ---------------------------------------------------------------------------

/** Per-repository sync options, typed to the repo's field names. */
export interface RepoSyncConfig<F extends string = string> {
  /** Override the SQL table name or Search index UID (default: repo name) */
  tableName?: string;
  /** Fields to exclude from the synced document */
  exclude?: F[];
  /** Field name overrides: Zod field → Target column/field name */
  columnMap?: Partial<Record<F, string>>;
  /**
   * Explicit Firestore document path pattern for triggers.
   * **Required** for collection-group repos (`isGroup: true`) because their
   * path cannot be auto-detected.
   * @example "posts/{postId}/comments/{docId}"
   */
  triggerPath?: string;
  /**
   * Optional list of target adapter names for this repo (e.g. `["bigquery", "meilisearch"]`).
   * When omitted or empty, the repo is synced to all configured adapters.
   */
  adapters?: string[];
  /**
   * Whether to flatten nested objects and stringify arrays into SQL-compatible columns.
   * - `true` (default): Flattens `{ address: { city: "Paris" } }` into `address__city: "Paris"` and stringifies arrays.
   * - `false`: Preserves nested objects and native arrays (ideal for Meilisearch / NoSQL search engines).
   */
  flat?: boolean;
  /**
   * Optional custom document transformation function applied after serialization.
   */
  transformDoc?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

import type { FieldPath } from "../shared/types";

/**
 * Extract the model type from a repo value.
 * Works with ConfiguredRepository (_modelType), raw config (schema.shape), or fallback (type).
 */
export type ExtractRepoModel<R> = R extends { _modelType: infer Model }
  ? Model
  : R extends { type: infer T }
    ? T
    : R extends { schema: { _output: infer O } }
      ? O
      : R extends { schema: { shape: infer S } }
        ? { [K in keyof S]: z.infer<S[K]> }
        : R extends { _output: infer O }
          ? O
          : Record<string, unknown>;

/**
 * Extract field names from a repo value.
 * Works with ConfiguredRepository (_modelType), raw config (schema.shape), or fallback (type).
 */
export type ExtractRepoFields<R> = string & keyof ExtractRepoModel<R>;

/**
 * Extract all dot-notation field paths (including nested objects) from a repo value.
 */
export type ExtractRepoFieldPaths<R> = FieldPath<ExtractRepoModel<R>>;

/** Keys of repos where `_isGroup` or `isGroup` is `true`. */
export type GroupRepoKeys<M> = {
  [K in string & keyof M]: M[K] extends { _isGroup: true }
    ? K
    : M[K] extends { isGroup: true }
      ? K
      : never;
}[string & keyof M];

/** Keys of repos where `_isGroup` is NOT `true`. */
export type NonGroupRepoKeys<M> = Exclude<string & keyof M, GroupRepoKeys<M>>;

/**
 * Typed per-repo sync config map.
 * - Collection-group repos (`isGroup: true`): entry is optional, but if provided,
 *   `triggerPath` is mandatory (since collection groups span multiple paths).
 * - Regular repos: entry is optional, all fields optional.
 */
export type TypedRepoSyncConfigs<M> = {
  [K in GroupRepoKeys<M>]?: RepoSyncConfig<ExtractRepoFields<M[K]>> & {
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
  onDocumentWritten: typeof onDocumentWritten;
}

/** PubSub handler from `firebase-functions/v2/pubsub`. */
export interface PubSubHandlerDep {
  onMessagePublished: typeof onMessagePublished;
}

/** PubSub client instance (e.g. `new PubSub()`). */
export interface PubSubClientDep {
  topic(name: string): {
    publishMessage(msg: any): Promise<any>;
    exists(): Promise<[boolean]>;
    create(): Promise<any>;
  };
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
  /**
   * Adapter(s) to flush data to. Accepts a single adapter, an array of adapters,
   * or a lazy factory returning one or more adapters.
   */
  adapter?: OrFactory<SyncAdapter | SyncAdapter[]>;
  /**
   * Explicit array of adapters to flush data to.
   */
  adapters?: OrFactory<SyncAdapter>[];
  /** Max rows per flush batch (default: 100) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Auto-create/migrate tables or indexes on first event (default: false) */
  autoMigrate?: boolean;
  /** PubSub topic prefix (default: "firestore-sync") */
  topicPrefix?: string;
  /**
   * Maximum number of times an event may be re-published to the dead-letter
   * topic before it is dropped (poison-message cap). Default: 5. Set to 0 to
   * disable the cap (events are re-published indefinitely). See issue #09.
   */
  maxDlqAttempts?: number;
  /**
   * Cloud Functions v2 options forwarded to `onMessagePublished()` for every
   * worker handler. Use to tune `concurrency`, `maxInstances`, `minInstances`,
   * `memory`, `timeoutSeconds`, `region`, `cpu`, etc.
   */
  workerOptions?: SyncWorkerOptions;
  /** Per-repo overrides */
  repos?: TypedRepoSyncConfigs<M>;
}

/** Options for `generateDDL()`. */
export interface GenerateDDLConfig<M = Record<string, any>> {
  /** Per-repo overrides */
  repos?: TypedRepoSyncConfigs<M>;
}

// ---------------------------------------------------------------------------
// Sync admin config
// ---------------------------------------------------------------------------

/**
 * HTTP Basic Auth configuration for the sync admin.
 */
export interface adminsyncBasicAuth {
  type: "basic";
  /** Realm displayed in the browser login dialog */
  realm?: string;
  username: string;
  password: string;
}

/**
 * Feature flags controlling which sync admin endpoints are enabled.
 */
export interface adminsyncFeaturesFlag {
  /** Allow force-syncing an entire collection (default: false) */
  manualSync?: boolean;
  /** Schema health check: expected vs actual storage structure (default: false) */
  healthCheck?: boolean;
  /** GCP / target config check: verify APIs, topics, targets, and IAM (default: false) */
  configCheck?: boolean;
}

/**
 * Configuration for the optional sync admin HTTP endpoint.
 * When provided in `FirestoreSyncConfig.admin`, an `onRequest` Cloud Function
 * handler is created and added to `sync.functions`.
 */
export interface adminsyncConfig {
  /**
   * Authentication guard. Accepts:
   * - {@link adminsyncBasicAuth} — HTTP Basic Auth (simple shared password),
   * - an `AuthExtension` returned by `firebaseAuth({ ... })` from
   *   `@lpdjs/firestore-repo-service/servers/auth` (cookie/bearer/both with
   *   inline login page), so the sync admin can use the same Firebase Auth
   *   process as `servers.admin()` / `servers.crud()`,
   * - a custom Connect-style middleware function.
   */
  auth?:
    | adminsyncBasicAuth
    | import("../servers/auth").AuthExtension
    | ((req: any, res: any, next: () => void) => void | Promise<void>);
  /** Base URL path (default: "/sync-admin") */
  basePath?: string;
  /** Feature flags controlling which endpoints are enabled */
  featuresFlag?: adminsyncFeaturesFlag;
  /**
   * `onRequest` from `firebase-functions/v2/https` (or `firebase-functions/https`,
   * which re-exports the v2 version in `firebase-functions` ≥ 5).
   * When provided, the admin handler is automatically wrapped as a Cloud Function.
   * If omitted, the raw `(req, res) => void` handler is exposed instead.
   */
  onRequest?: typeof onRequest;
  /**
   * Options forwarded to `onRequest()` as the first argument (e.g. `{ invoker: "public" }`).
   * Only used when `onRequest` is also provided.
   */
  httpsOptions?: AdminHttpsOptions;
}

/** Options for `createFirestoreSync()` — the unified wrapper. */
export interface FirestoreSyncConfig<M = Record<string, any>> {
  /**
   * External dependencies — all Firebase/PubSub modules.
   * `pubsub` can be a factory `() => PubSub` for lazy initialization
   * (avoids creating gRPC channels at module-load time for functions that
   * don't need PubSub, e.g. the admin or CRUD servers).
   */
  deps: Omit<SyncDeps, "pubsub"> & { pubsub: OrFactory<PubSubClientDep> };
  /**
   * Sync adapter(s) to flush data to (e.g. BigQueryAdapter, MeilisearchAdapter).
   * Can be a single adapter, an array of adapters, or a lazy factory.
   */
  adapter?: OrFactory<SyncAdapter | SyncAdapter[]>;
  /**
   * Explicit array of adapters to flush data to.
   */
  adapters?: OrFactory<SyncAdapter>[];
  /** PubSub topic name prefix (topics will be `{prefix}-{repoName}`) */
  topicPrefix?: string;
  /** Max rows per flush batch (default: 100) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Auto-create/migrate tables or indexes on first event (default: false) */
  autoMigrate?: boolean;
  /**
   * Cloud Functions v2 options forwarded to `onMessagePublished()` for every
   * worker handler. Use to tune `concurrency`, `maxInstances`, `minInstances`,
   * `memory`, `timeoutSeconds`, `region`, `cpu`, etc.
   */
  workerOptions?: SyncWorkerOptions;
  /**
   * Optional sync admin endpoint. When provided, an `adminsync` handler is
   * added to `sync.functions` exposing health-check, force-sync, and queue
   * inspection endpoints behind authentication.
   */
  admin?: adminsyncConfig;
  /** Per-repo overrides (shared between triggers and worker) */
  repos?: TypedRepoSyncConfigs<M>;
}
