/**
 * History module — opt-in change-log capture & read API.
 *
 * @example
 * ```ts
 * import { createHistoryTriggers } from "@lpdjs/firestore-repo-service/history";
 * ```
 *
 * @packageDocumentation
 */

export { createHistoryTriggers } from "./triggers";
export { createHistoryMethods } from "./read";
export type { HistoryMethods } from "./read";
export {
  buildHistoryEntry,
  extractMeta,
  metaFieldsOf,
  writeHistoryEntry,
} from "./write";
export { computeDiff, valueType, valuesEqual } from "./diff";
export {
  normalizeHistoryDocs,
  DEFAULT_GROUP_TOLERANCE_MS,
} from "./normalize";

export type {
  HistoryConfigBase,
  HistoryConfigForModel,
  HistoryEntry,
  HistoryFieldChange,
  HistoryFirestoreTriggersDep,
  HistoryListOptions,
  HistoryMeta,
  HistoryOperation,
  HistoryRawListOptions,
  HistoryTriggerRepoOverride,
  HistoryTriggersConfig,
  HistoryValueType,
  V1HistoryDoc,
  V2HistoryDoc,
} from "./types";
