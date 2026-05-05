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
  SyncDeps,
  SyncEvent,
  SyncOperation,
  SyncTriggersConfig,
  SyncWorkerConfig,
  adminsyncBasicAuth,
  adminsyncConfig,
  adminsyncFeaturesFlag,
} from "./types";

export { createadminsyncServer } from "./admin";
export { createFirestoreSync } from "./create-sync";
export { addColumnsDDL, createTableDDL, generateDDL } from "./ddl-generator";
export { autoMigrate } from "./migration";
export type { MigrateResult } from "./migration";
export { SyncQueue } from "./queue";
export type { SyncQueueOptions } from "./queue";
export { zodSchemaToColumns, zodTypeToLogical } from "./schema-mapper";
export { serializeDocument, serializeValue } from "./serializer";
export { createSyncTriggers } from "./triggers";
export { createSyncWorker } from "./worker";
