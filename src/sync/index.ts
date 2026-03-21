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
  SqlColumn,
  SqlTableDef,
  SqlDialect,
  SqlAdapter,
  LogicalType,
  SyncEvent,
  SyncOperation,
  RepoSyncConfig,
  SyncTriggersConfig,
  SyncWorkerConfig,
  GenerateDDLConfig,
  FirestoreSyncConfig,
} from "./types";

export { zodTypeToLogical, zodSchemaToColumns } from "./schema-mapper";
export { serializeValue, serializeDocument } from "./serializer";
export { createTableDDL, addColumnsDDL, generateDDL } from "./ddl-generator";
export { SyncQueue } from "./queue";
export type { SyncQueueOptions } from "./queue";
export { createSyncWorker } from "./worker";
export { autoMigrate } from "./migration";
export type { MigrateResult } from "./migration";
export { createSyncTriggers } from "./triggers";
export { createFirestoreSync } from "./create-sync";
