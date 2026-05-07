/**
 * v1 ↔ v2 normalisation. The reader returns a unified {@link HistoryEntry}
 * shape regardless of which schema version a Firestore document was written
 * with.
 *
 * v2 doc → pass-through.
 * v1 doc (single field per doc) → wrapped into a 1-field unified entry.
 *   Consecutive v1 docs that share the same `historySetAt` timestamp
 *   (within a small tolerance) are merged into a single entry, mimicking
 *   the original "one update -> N field docs" intent.
 */

import { Timestamp } from "firebase-admin/firestore";
import type {
  HistoryEntry,
  HistoryFieldChange,
  HistoryMeta,
  HistoryValueType,
  V1HistoryDoc,
  V2HistoryDoc,
} from "./types";
import { valueType } from "./diff";

/** Default tolerance (ms) used to group v1 docs from the same update. */
export const DEFAULT_GROUP_TOLERANCE_MS = 5;

type AnyHistoryDoc = (V1HistoryDoc | V2HistoryDoc) & Record<string, unknown>;

function isV2(doc: AnyHistoryDoc): doc is V2HistoryDoc & Record<string, unknown> {
  return doc.schemaVersion === 2;
}

function legacyTypeToHistoryType(t: unknown): HistoryValueType {
  if (typeof t !== "string") return "object";
  switch (t) {
    case "string":
    case "number":
    case "boolean":
    case "object":
    case "array":
    case "timestamp":
    case "date":
    case "null":
    case "undefined":
      return t;
    default:
      return "object";
  }
}

function v2ToEntry(doc: V2HistoryDoc): HistoryEntry {
  return {
    historyDocId: doc.historyDocId,
    historyToObjectId: doc.historyToObjectId,
    historySetAt: doc.historySetAt,
    schemaVersion: 2,
    operation: doc.operation,
    meta: doc.meta ?? {},
    changes: doc.changes ?? {},
  };
}

function v1MetaOf(doc: V1HistoryDoc & Record<string, unknown>): HistoryMeta {
  const meta: HistoryMeta = {};
  if (doc.historyUserId !== undefined) meta.userId = doc.historyUserId ?? null;
  if (doc.historyUserEmail !== undefined)
    meta.userEmail = doc.historyUserEmail ?? null;

  const extra = doc.extraHistoryDetails ?? null;
  if (extra) {
    if (extra.reason !== undefined) meta.reason = extra.reason ?? null;
    if (extra.comment !== undefined) meta.comment = extra.comment ?? null;
  }

  const extras: Record<string, unknown> = {};
  let anyExtra = false;
  if (doc.historyDetails && typeof doc.historyDetails === "object") {
    for (const [k, v] of Object.entries(doc.historyDetails)) {
      extras[k] = v;
      anyExtra = true;
    }
  }
  if (doc.extraContentKeys && typeof doc.extraContentKeys === "object") {
    for (const [k, v] of Object.entries(doc.extraContentKeys)) {
      extras[`content.${k}`] = v;
      anyExtra = true;
    }
  }
  if (anyExtra) meta.extras = extras;
  return meta;
}

function v1FieldChange(doc: V1HistoryDoc): HistoryFieldChange {
  const oldValue = doc.changes?.oldValue ?? null;
  const newValue = doc.changes?.newValue ?? null;
  const declaredOld = doc.types?.oldValue;
  const declaredNew = doc.types?.newValue;
  return {
    oldValue,
    newValue,
    type: {
      old: declaredOld
        ? legacyTypeToHistoryType(declaredOld)
        : valueType(oldValue),
      new: declaredNew
        ? legacyTypeToHistoryType(declaredNew)
        : valueType(newValue),
    },
  };
}

function v1ToEntry(doc: V1HistoryDoc): HistoryEntry {
  const change = v1FieldChange(doc);
  const meta = v1MetaOf(doc as V1HistoryDoc & Record<string, unknown>);
  return {
    historyDocId: doc.historyDocId,
    historyToObjectId: doc.historyToObjectId,
    historySetAt: doc.historySetAt,
    schemaVersion: 1,
    operation: "update",
    meta,
    changes: { [doc.field]: change },
  };
}

function tsClose(a: Timestamp, b: Timestamp, toleranceMs: number): boolean {
  return Math.abs(a.toMillis() - b.toMillis()) <= toleranceMs;
}

function sameAuthor(a: HistoryMeta, b: HistoryMeta): boolean {
  return (a.userId ?? null) === (b.userId ?? null);
}

/**
 * Normalise a list of raw Firestore docs into unified {@link HistoryEntry}.
 * The input list MUST be sorted by `historySetAt` (asc or desc — the function
 * preserves order). v1 docs sharing the same timestamp + author are merged.
 */
export function normalizeHistoryDocs(
  docs: AnyHistoryDoc[],
  opts: { groupToleranceMs?: number } = {},
): HistoryEntry[] {
  const tol = opts.groupToleranceMs ?? DEFAULT_GROUP_TOLERANCE_MS;
  const out: HistoryEntry[] = [];

  for (const doc of docs) {
    if (isV2(doc)) {
      out.push(v2ToEntry(doc));
      continue;
    }

    const v1 = doc as V1HistoryDoc;
    const entry = v1ToEntry(v1);

    const last = out[out.length - 1];
    if (
      last &&
      last.schemaVersion === 1 &&
      tsClose(last.historySetAt, entry.historySetAt, tol) &&
      sameAuthor(last.meta, entry.meta)
    ) {
      // Merge into the previous v1 entry (same logical update).
      Object.assign(last.changes, entry.changes);
      // Keep earliest historyDocId (stable id of the group).
    } else {
      out.push(entry);
    }
  }

  return out;
}
