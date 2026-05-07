/**
 * `repo.history.*` read API.
 *
 * - `list(docId, opts)` → unified, paginated, normalised entries (v1 + v2).
 * - `raw(docId, opts)`  → raw Firestore docs (no normalisation).
 * - `byField(docId, field, opts)` / `byOperation(docId, op, opts)` →
 *   convenience wrappers.
 * - `recordManual(docId, payload)` → bypass the trigger and write a v2 entry
 *   synchronously (use sparingly; prefer trigger-based capture).
 */

import {
  Timestamp,
  type CollectionReference,
  type DocumentReference,
} from "firebase-admin/firestore";
import { computeDiff } from "./diff";
import { normalizeHistoryDocs } from "./normalize";
import {
  buildHistoryEntry,
  extractMeta,
  metaFieldsOf,
  writeHistoryEntry,
} from "./write";
import type {
  HistoryConfigForModel,
  HistoryEntry,
  HistoryListOptions,
  HistoryMeta,
  HistoryOperation,
  HistoryRawListOptions,
  V1HistoryDoc,
  V2HistoryDoc,
} from "./types";

const DEFAULT_SUBCOLLECTION = "history";
const DEFAULT_LIMIT = 50;

function getHistoryRef(
  documentRef: (...args: any[]) => DocumentReference,
  subcollection: string,
  args: any[],
): CollectionReference {
  const docRef = documentRef(...args);
  return docRef.collection(subcollection);
}

function getDocId(args: any[]): string {
  return String(args[args.length - 1] ?? "");
}

/**
 * Build the `repo.history` API for a given configured repository.
 * Returns `null` when history is not enabled — the factory then skips
 * exposing the namespace.
 */
export function createHistoryMethods<T>(
  documentRef: (...args: any[]) => DocumentReference,
  systemKeys: string[],
  repoName: string,
  config: HistoryConfigForModel<T> & { enabled: boolean },
) {
  if (!config?.enabled) return null;

  const subcollection = config.subcollection ?? DEFAULT_SUBCOLLECTION;

  async function raw(
    ...args: any[]
  ): Promise<Array<{ id: string; data: V1HistoryDoc | V2HistoryDoc }>> {
    let opts: HistoryRawListOptions = {};
    let pathArgs = args;
    const last = args[args.length - 1];
    if (
      last !== null &&
      typeof last === "object" &&
      !(last instanceof Timestamp) &&
      ("limit" in last || "cursor" in last || "direction" in last)
    ) {
      opts = last as HistoryRawListOptions;
      pathArgs = args.slice(0, -1);
    }

    const ref = getHistoryRef(documentRef, subcollection, pathArgs);
    const direction = opts.direction ?? "desc";
    let q = ref.orderBy("historySetAt", direction);
    if (opts.cursor) q = q.startAfter(opts.cursor);
    if (opts.limit && opts.limit > 0) q = q.limit(opts.limit);

    const snap = await q.get();
    return snap.docs.map((d) => ({
      id: d.id,
      data: d.data() as V1HistoryDoc | V2HistoryDoc,
    }));
  }

  async function list(
    ...args: any[]
  ): Promise<HistoryEntry<T>[]> {
    let opts: HistoryListOptions<T> = {};
    let pathArgs = args;
    const last = args[args.length - 1];
    if (
      last !== null &&
      typeof last === "object" &&
      !(last instanceof Timestamp) &&
      ("limit" in last ||
        "cursor" in last ||
        "direction" in last ||
        "fields" in last ||
        "operations" in last)
    ) {
      opts = last as HistoryListOptions<T>;
      pathArgs = args.slice(0, -1);
    }

    const limit = opts.limit ?? DEFAULT_LIMIT;
    // Read a bit more from Firestore because v1 entries get merged afterwards.
    // Cap at limit * 8 to avoid pathological reads.
    const fetchLimit = Math.max(limit, Math.min(limit * 8, 500));

    const rawDocs = await raw(...pathArgs, {
      limit: fetchLimit,
      cursor: opts.cursor,
      direction: opts.direction ?? "desc",
    });

    let entries = normalizeHistoryDocs(
      rawDocs.map((d) => d.data) as any[],
    ) as HistoryEntry<T>[];

    if (opts.fields && opts.fields.length > 0) {
      const set = new Set<string>(opts.fields as string[]);
      entries = entries.filter((e) =>
        Object.keys(e.changes).some((k) => set.has(k)),
      );
    }
    if (opts.operations && opts.operations.length > 0) {
      const set = new Set<HistoryOperation>(opts.operations);
      entries = entries.filter((e) => set.has(e.operation));
    }

    return entries.slice(0, limit);
  }

  async function byField(
    ...args: any[]
  ): Promise<HistoryEntry<T>[]> {
    const last = args[args.length - 1];
    let opts: HistoryListOptions<T> = {};
    let field: keyof T & string;
    let pathArgs: any[];
    if (last !== null && typeof last === "object" && !(last instanceof Timestamp)) {
      opts = last as HistoryListOptions<T>;
      field = args[args.length - 2] as keyof T & string;
      pathArgs = args.slice(0, -2);
    } else {
      field = last as keyof T & string;
      pathArgs = args.slice(0, -1);
    }
    return list(...pathArgs, { ...opts, fields: [field] });
  }

  async function byOperation(
    ...args: any[]
  ): Promise<HistoryEntry<T>[]> {
    const last = args[args.length - 1];
    let opts: HistoryListOptions<T> = {};
    let op: HistoryOperation;
    let pathArgs: any[];
    if (last !== null && typeof last === "object" && !(last instanceof Timestamp)) {
      opts = last as HistoryListOptions<T>;
      op = args[args.length - 2] as HistoryOperation;
      pathArgs = args.slice(0, -2);
    } else {
      op = last as HistoryOperation;
      pathArgs = args.slice(0, -1);
    }
    return list(...pathArgs, { ...opts, operations: [op] });
  }

  /**
   * Manually record a history entry. Bypasses the trigger and lets the caller
   * pass an explicit before/after pair plus meta (useful for synchronous flows
   * that need richer context than what the trigger can extract).
   */
  async function recordManual(
    ...args: any[]
  ): Promise<HistoryEntry<T> | null> {
    const payload = args[args.length - 1] as {
      operation: HistoryOperation;
      before?: T | null;
      after?: T | null;
      meta?: HistoryMeta;
    };
    const pathArgs = args.slice(0, -1);
    const entityId = getDocId(pathArgs);

    const changes = computeDiff(
      (payload.before ?? {}) as Record<string, unknown>,
      (payload.after ?? {}) as Record<string, unknown>,
      {
        include: config.include as string[] | undefined,
        exclude: config.exclude as string[] | undefined,
        metaFields: metaFieldsOf(config),
        systemKeys,
      },
    );
    if (
      payload.operation === "update" &&
      Object.keys(changes).length === 0
    ) {
      return null;
    }

    const fallbackMeta = extractMeta(
      (payload.after ?? payload.before ?? null) as Record<string, unknown> | null,
      config,
    );
    const meta: HistoryMeta = { ...fallbackMeta, ...(payload.meta ?? {}) };

    const entry = buildHistoryEntry({
      entityId,
      operation: payload.operation,
      changes,
      meta,
      config,
    });

    const ref = getHistoryRef(documentRef, subcollection, pathArgs);
    const result = await writeHistoryEntry(ref, entry, config, {
      repoName,
      docId: entityId,
      before: payload.before ?? null,
      after: payload.after ?? null,
    });
    if (!result.written || !result.entry) return null;

    return {
      historyDocId: result.entry.historyDocId,
      historyToObjectId: result.entry.historyToObjectId,
      historySetAt: result.entry.historySetAt,
      schemaVersion: 2,
      operation: result.entry.operation,
      meta: result.entry.meta,
      changes: result.entry.changes,
    } as HistoryEntry<T>;
  }

  return { list, raw, byField, byOperation, recordManual };
}

export type HistoryMethods<T> = NonNullable<
  ReturnType<typeof createHistoryMethods<T>>
>;
