/**
 * Types and interfaces for the history (change-log) module.
 *
 * The package writes history entries in **schema v2** (1 Firestore document
 * per `update`/`create`/`delete` event, with a `changes` map keyed by field
 * name). It reads both v1 (legacy: 1 doc per modified field) and v2 by
 * normalising them into a unified {@link HistoryEntry} shape.
 */

import type { Timestamp } from "firebase-admin/firestore";
import type { onDocumentWritten } from "firebase-functions/v2/firestore";

/* ------------------------------------------------------------------------- */
/* Public unified shape                                                      */
/* ------------------------------------------------------------------------- */

export type HistoryOperation = "create" | "update" | "delete";

/**
 * Detected JS/Firestore type of a value as stored in a history entry.
 * Matches the values returned by {@link valueType}.
 */
export type HistoryValueType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "date"
  | "array"
  | "object"
  | "null"
  | "undefined";

/** A single field change inside a history entry. */
export interface HistoryFieldChange {
  oldValue: unknown;
  newValue: unknown;
  type: { old: HistoryValueType; new: HistoryValueType };
}

/** Captured metadata for a history entry. */
export interface HistoryMeta {
  userId?: string | null;
  userEmail?: string | null;
  reason?: string | null;
  comment?: string | null;
  /** Free-form extra fields copied from the source document. */
  extras?: Record<string, unknown>;
}

/**
 * Unified history entry returned by `repo.history.list(...)`.
 * Both v1 and v2 documents are normalised into this shape.
 */
export interface HistoryEntry<T = Record<string, unknown>> {
  /** Stable id of the underlying Firestore history document (the v1+v2 storage doc). */
  historyDocId: string;
  /** Id of the entity this entry belongs to. */
  historyToObjectId: string;
  /** When the change was recorded. */
  historySetAt: Timestamp;
  /** Source schema version. v1 = legacy (1 doc/field), v2 = current (1 doc/update). */
  schemaVersion: 1 | 2;
  /** v2 only — v1 is always normalised to "update". */
  operation: HistoryOperation;
  /** Captured author / context information. */
  meta: HistoryMeta;
  /** Per-field changes. Keys are field names of T. */
  changes: { [K in keyof T & string]?: HistoryFieldChange } & {
    [field: string]: HistoryFieldChange;
  };
}

/* ------------------------------------------------------------------------- */
/* Storage-level shapes (what is actually written / read in Firestore)       */
/* ------------------------------------------------------------------------- */

/** v2 document layout. */
export interface V2HistoryDoc {
  schemaVersion: 2;
  historyDocId: string;
  historyToObjectId: string;
  historySetAt: Timestamp;
  operation: HistoryOperation;
  meta: HistoryMeta;
  changes: Record<string, HistoryFieldChange>;
  /** Optional TTL marker (Firestore deletes the doc after this date). */
  expiresAt?: Timestamp;
  /** Set when the doc had to be truncated to fit the 1 MiB limit. */
  _truncated?: boolean;
}

/** v1 document layout (legacy — read-only support). */
export interface V1HistoryDoc {
  // schemaVersion is absent in v1.
  schemaVersion?: undefined;
  historyDocId: string;
  historyToObjectId: string;
  historyUserId?: string;
  historyUserEmail?: string;
  historySetAt: Timestamp;
  field: string;
  changes: { oldValue: unknown; newValue: unknown };
  types?: { oldValue: string; newValue: string };
  // Extra freeform metadata seen in legacy code.
  historyDetails?: Record<string, unknown> | null;
  extraHistoryDetails?: {
    comment?: string;
    reason?: string;
    toKey?: string;
    force?: boolean;
  } | null;
  extraContentKeys?: Record<string, unknown> | null;
  objectType?: string;
}

/* ------------------------------------------------------------------------- */
/* Configuration                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Per-repo history configuration. Attached on the repository config under
 * the `history` key. All meta sub-keys must reference fields that exist on
 * the model (compile-time enforced by {@link HistoryConfigForModel}).
 */
export interface HistoryConfigBase {
  /** Master switch — when false/absent, no triggers are generated and no `repo.history` API is exposed. */
  enabled: boolean;
  /** Subcollection name used to store history docs. Default: "history". */
  subcollection?: string;
  /**
   * Optional Firestore TTL configuration. When set, every written history doc
   * gets a Timestamp field (default name: `expiresAt`) at `now + days`.
   * You still need to enable the TTL policy on that field via gcloud / console.
   */
  ttl?: { field?: string; days: number };
}

/**
 * Strongly-typed history config bound to a model `T`.
 *
 * - `meta.*` keys must be keyof T (or string for `extras` entries).
 * - `include` / `exclude` accept keyof T.
 */
export interface HistoryConfigForModel<T> extends HistoryConfigBase {
  meta?: {
    /** Field on T that holds the author user id. */
    userId?: keyof T & string;
    /** Field on T that holds the author email. */
    userEmail?: keyof T & string;
    /** Field on T that holds an optional change reason. */
    reason?: keyof T & string;
    /** Field on T that holds an optional change comment. */
    comment?: keyof T & string;
    /** Free-form extra field names copied verbatim into `meta.extras`. */
    extras?: (keyof T & string)[];
  };
  /** When set, only these top-level fields are diffed. */
  include?: (keyof T & string)[];
  /** Always excluded from the diff (in addition to meta + system keys). */
  exclude?: (keyof T & string)[];
  /**
   * Optional async hook to enrich/mutate an entry before it's written.
   * Return `null` to drop the entry entirely.
   */
  onBeforeWrite?: (
    entry: V2HistoryDoc,
    ctx: { repoName: string; docId: string; before: T | null; after: T | null },
  ) => V2HistoryDoc | null | Promise<V2HistoryDoc | null>;
}

/* ------------------------------------------------------------------------- */
/* Read API options                                                          */
/* ------------------------------------------------------------------------- */

export interface HistoryListOptions<T = unknown> {
  /** Max number of normalised entries to return. Default: 50. */
  limit?: number;
  /** Cursor for pagination (use `historySetAt` of the last received entry). */
  cursor?: Timestamp;
  /** Sort direction on `historySetAt`. Default: "desc". */
  direction?: "asc" | "desc";
  /** Restrict to entries that touch any of these fields (post-filter). */
  fields?: (keyof T & string)[];
  /** Restrict to entries with these operations (v2 only — v1 is always "update"). */
  operations?: HistoryOperation[];
}

export interface HistoryRawListOptions {
  limit?: number;
  cursor?: Timestamp;
  direction?: "asc" | "desc";
}

/* ------------------------------------------------------------------------- */
/* Trigger factory configuration                                             */
/* ------------------------------------------------------------------------- */

/**
 * Firestore trigger constructors injected by the consumer.
 * Mirrors the DI pattern used by `createSyncTriggers`.
 */
export interface HistoryFirestoreTriggersDep {
  // Either onDocumentWritten alone is enough; we keep the more granular ones
  // available so the worker can stay efficient.
  onDocumentWritten: typeof onDocumentWritten;
}

/** Per-repo override at the `createHistoryTriggers` call site. */
export interface HistoryTriggerRepoOverride {
  /**
   * Explicit Firestore document path pattern. Required for collection-group
   * repositories whose path cannot be auto-detected.
   * @example "residences/{residenceId}/workshops/{docId}"
   */
  triggerPath?: string;
}

export interface HistoryTriggersConfig<M = Record<string, any>> {
  deps: HistoryFirestoreTriggersDep;
  /** Defaults applied to every repo unless overridden. */
  defaults?: { ttl?: { field?: string; days: number } };
  /** Per-repo overrides keyed by repo name in the mapping. */
  repos?: Partial<Record<keyof M & string, HistoryTriggerRepoOverride>>;
}
