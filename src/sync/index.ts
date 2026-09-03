/**
 * Firestore → SQL sync module.
 *
 * @example
 * ```typescript
 * import { createSyncTriggers, createSyncWorker, generateDDL } from '@lpdjs/firestore-repo-service/sync';
 * ```
 *
 * @packageDocumentation
 */

export type {
  FirestoreSyncConfig,
  FirestoreTriggersDep,
  GenerateDDLConfig,
  LogicalType,
  OrFactory,
  PubSubClientDep,
  PubSubHandlerDep,
  RepoSyncConfig,
  SqlAdapter,
  SqlColumn,
  SqlDialect,
  SqlTableDef,
  SyncAdapter,
  SyncDeps,
  SyncEvent,
  SyncHealthResult,
  SyncOperation,
  SyncTriggersConfig,
  SyncWorkerConfig,
  SyncWorkerOptions,
  AdminHttpsOptions,
  adminsyncBasicAuth,
  adminsyncConfig,
  adminsyncFeaturesFlag,
} from "./types";

export { createFirestoreSync } from "./create-sync";
export { createadminsyncServer } from "./admin";
export { addColumnsDDL, createTableDDL, generateDDL } from "./ddl-generator";
export { autoMigrate } from "./migration";
export type { MigrateResult } from "./migration";
export { SyncQueue } from "./queue";
export type { SyncQueueOptions } from "./queue";
export { zodSchemaToColumns, zodTypeToLogical } from "./schema-mapper";
export { serializeDocument, serializeValue } from "./serializer";
export { createSyncTriggers } from "./triggers";
export { createSyncWorker, SchemaTypeMismatchError } from "./worker";
export { BigQueryAdapter, bigqueryDialect } from "./adapters/bigquery";
export type { BigQueryAdapterOptions } from "./adapters/bigquery";
export { MeilisearchAdapter } from "./adapters/meilisearch";
export type {
  MeilisearchAdapterOptions,
  MeilisearchIndexSettings,
  MeilisearchLike,
} from "./adapters/meilisearch";

