/**
 * Write helpers for history entries.
 *
 * Builds a {@link V2HistoryDoc} from a diff + meta payload and writes it to
 * the entity's history subcollection. Used by {@link createHistoryTriggers}
 * and by the optional `repo.history.recordManual(...)` API.
 */

import {
  Timestamp,
  type CollectionReference,
} from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import type {
  HistoryConfigForModel,
  HistoryFieldChange,
  HistoryMeta,
  HistoryOperation,
  V2HistoryDoc,
} from "./types";

export interface BuildEntryParams<T> {
  entityId: string;
  operation: HistoryOperation;
  changes: Record<string, HistoryFieldChange>;
  meta: HistoryMeta;
  config: HistoryConfigForModel<T>;
  ttlOverride?: { days: number };
}

/** Soft size guard — leave ~300 KiB headroom under Firestore's 1 MiB limit. */
const MAX_DOC_BYTES = 700_000;

export function buildHistoryEntry<T>(
  params: BuildEntryParams<T>,
): V2HistoryDoc {
  const ttl = params.ttlOverride ?? params.config.ttl;
  const id = randomUUID();
  const entry: V2HistoryDoc = {
    schemaVersion: 2,
    historyDocId: id,
    historyToObjectId: params.entityId,
    historySetAt: Timestamp.now(),
    operation: params.operation,
    meta: params.meta,
    changes: params.changes,
  };
  if (ttl) {
    entry.expiresAt = Timestamp.fromMillis(
      Date.now() + ttl.days * 24 * 60 * 60 * 1000,
    );
  }

  // Soft size guard — if the JSON projection of `changes` is too large,
  // truncate large fields and mark the doc.
  const sizeOf = (obj: unknown): number => {
    try {
      return Buffer.byteLength(
        JSON.stringify(obj, (_k, v) => {
          if (v instanceof Timestamp) return v.toMillis();
          return v;
        }),
        "utf8",
      );
    } catch {
      return 0;
    }
  };

  if (sizeOf(entry.changes) > MAX_DOC_BYTES) {
    const truncated: Record<string, HistoryFieldChange> = {};
    for (const [k, change] of Object.entries(entry.changes)) {
      const oldSize = sizeOf(change.oldValue);
      const newSize = sizeOf(change.newValue);
      truncated[k] = {
        oldValue:
          oldSize > 50_000 ? "[truncated]" : change.oldValue,
        newValue:
          newSize > 50_000 ? "[truncated]" : change.newValue,
        type: change.type,
      };
    }
    entry.changes = truncated;
    entry._truncated = true;
  }

  return entry;
}

export interface WriteEntryResult {
  written: boolean;
  entry?: V2HistoryDoc;
  reason?: string;
}

/**
 * Write a single history entry to the given subcollection reference.
 * Returns `{ written: false }` when the entry was dropped by `onBeforeWrite`.
 */
export async function writeHistoryEntry<T>(
  historyRef: CollectionReference,
  entry: V2HistoryDoc,
  config: HistoryConfigForModel<T>,
  ctx: { repoName: string; docId: string; before: T | null; after: T | null },
): Promise<WriteEntryResult> {
  let toWrite: V2HistoryDoc | null = entry;
  if (config.onBeforeWrite) {
    toWrite = await config.onBeforeWrite(entry, ctx);
  }
  if (!toWrite) return { written: false, reason: "dropped-by-onBeforeWrite" };

  await historyRef.doc(toWrite.historyDocId).set(toWrite);
  return { written: true, entry: toWrite };
}

/**
 * Extract meta values from a Firestore document snapshot using the
 * declared meta config. Missing fields become `null`.
 */
export function extractMeta<T>(
  source: Record<string, unknown> | null | undefined,
  config: HistoryConfigForModel<T>,
): HistoryMeta {
  const src = source ?? {};
  const meta: HistoryMeta = {};
  const m = config.meta;
  if (!m) return meta;

  const pickStr = (key?: string): string | null | undefined => {
    if (!key) return undefined;
    const v = src[key];
    if (v === undefined) return null;
    return v === null ? null : String(v);
  };

  const userId = pickStr(m.userId);
  if (userId !== undefined) meta.userId = userId;
  const userEmail = pickStr(m.userEmail);
  if (userEmail !== undefined) meta.userEmail = userEmail;
  const reason = pickStr(m.reason);
  if (reason !== undefined) meta.reason = reason;
  const comment = pickStr(m.comment);
  if (comment !== undefined) meta.comment = comment;

  if (m.extras && m.extras.length > 0) {
    const extras: Record<string, unknown> = {};
    let any = false;
    for (const k of m.extras) {
      if (k in src) {
        extras[k] = src[k];
        any = true;
      }
    }
    if (any) meta.extras = extras;
  }

  return meta;
}

/**
 * Returns all field names that should be excluded from the diff because
 * they're declared as meta fields (so we don't log them as their own change).
 */
export function metaFieldsOf<T>(config: HistoryConfigForModel<T>): string[] {
  const m = config.meta;
  if (!m) return [];
  const list: string[] = [];
  if (m.userId) list.push(m.userId);
  if (m.userEmail) list.push(m.userEmail);
  if (m.reason) list.push(m.reason);
  if (m.comment) list.push(m.comment);
  if (m.extras) list.push(...m.extras);
  return list;
}
