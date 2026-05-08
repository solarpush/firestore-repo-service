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
): HistoryMethods<T> | null {
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

  return { list, raw, byField, byOperation, recordManual } as HistoryMethods<T>;
}

/**
 * Public, strongly-typed surface of the `repo.history` namespace.
 *
 * Exposed on a repository **only when** `history.enabled: true` is set in
 * its config. Reads from the entity's `history` subcollection (or the custom
 * name set via `history.subcollection`) and normalises both schema versions
 * (v1 = one doc per modified field, v2 = one doc per write) into a single
 * {@link HistoryEntry} shape.
 *
 * ### Path arguments
 *
 * Every method's leading positional arguments mirror
 * `Parameters<repo.documentRef>`, so the call signature stays consistent with
 * the rest of the repo API:
 *
 * - **Top-level collection** (`documentRef: (db, docId) => …`)
 *   → `repo.history.list("doc_42", opts?)`
 * - **Subcollection** (`documentRef: (db, parentId, docId) => …`)
 *   → `repo.history.list("parent_1", "doc_42", opts?)`
 *
 * The trailing options/payload argument keeps the same position whatever the
 * depth of the path.
 *
 * ### Pagination
 *
 * `list` / `byField` / `byOperation` use real Firestore cursors via the
 * `cursor` + `limit` options on {@link HistoryListOptions} — no in-memory
 * slicing, safe for large histories.
 *
 * @example Basic read
 * ```ts
 * const entries = await repos.residences.history!.list("residence_123", {
 *   limit: 50,
 *   direction: "desc",
 * });
 * for (const e of entries) {
 *   console.log(e.historySetAt.toDate(), e.operation, e.meta.userId);
 * }
 * ```
 *
 * @example Filter by field (autocompleted on `keyof T`)
 * ```ts
 * const addressChanges = await repos.residences.history!.byField(
 *   "residence_123",
 *   "address",
 * );
 * ```
 *
 * @template T         - The repository's model type. Field-name parameters
 *                       (e.g. `byField`'s `K`) and `HistoryEntry<T>` payloads
 *                       are derived from this.
 * @template PathArgs  - Tuple of path-segment args inherited from the repo's
 *                       `documentRef`. Defaults to `[string]` (a single
 *                       `docId`) when used standalone.
 *
 * @see {@link createHistoryMethods}  - factory used internally by `createRepository`.
 * @see {@link HistoryEntry}          - normalised return shape.
 * @see {@link HistoryListOptions}    - pagination + filter options.
 */
export interface HistoryMethods<T, PathArgs extends readonly unknown[] = [string]> {
  /**
   * List normalised history entries for a single document.
   *
   * Reads both v1 and v2 docs and folds v1 field-per-doc entries that share
   * the same author + timestamp (±5 ms) into a single logical entry, so the
   * caller never has to care about the storage version.
   *
   * @param args - `[...pathArgs, options?]`. `pathArgs` mirror the repo's
   *               `documentRef`. `options` accepts `limit`, `cursor`,
   *               `direction`, `fields`, `operations`.
   * @returns Array of {@link HistoryEntry} ordered by `historySetAt`
   *          (`direction` defaults to `"desc"`).
   */
  list(
    ...args: [...PathArgs, HistoryListOptions<T>?]
  ): Promise<HistoryEntry<T>[]>;

  /**
   * Escape hatch returning **raw** Firestore documents (v1 or v2) without
   * normalisation. Use only when {@link list} doesn't expose the field you
   * need (custom legacy fields, debugging, migrations).
   *
   * @param args - `[...pathArgs, options?]`. Supports the same pagination
   *               options as `list`, minus model-aware filters.
   */
  raw(
    ...args: [...PathArgs, HistoryRawListOptions?]
  ): Promise<Array<{ id: string; data: V1HistoryDoc | V2HistoryDoc }>>;

  /**
   * Convenience wrapper around {@link list} that only returns entries
   * touching a specific field. Field name is checked against `keyof T` at
   * compile time.
   *
   * @typeParam K - A literal key of the model `T`.
   * @param args  - `[...pathArgs, field, options?]`.
   *
   * @example
   * ```ts
   * await repos.users.history!.byField("user_42", "email");
   * ```
   */
  byField<K extends keyof T & string>(
    ...args: [...PathArgs, K, HistoryListOptions<T>?]
  ): Promise<HistoryEntry<T>[]>;

  /**
   * Convenience wrapper around {@link list} filtering on the operation type.
   *
   * @param args - `[...pathArgs, operation, options?]` where `operation` is
   *               `"create" | "update" | "delete"`.
   *
   * @example
   * ```ts
   * await repos.residences.history!.byOperation("residence_123", "delete");
   * ```
   */
  byOperation(
    ...args: [...PathArgs, HistoryOperation, HistoryListOptions<T>?]
  ): Promise<HistoryEntry<T>[]>;

  /**
   * Synchronously append a custom history entry, bypassing the trigger.
   *
   * Useful when:
   * - You already have richer business context than the trigger can extract
   *   (e.g. inside an HTTP handler that knows the authenticated user).
   * - You want to record an event that isn't a Firestore write (e.g.
   *   `meta.reason = "exported-to-pdf"`).
   *
   * Honours the same `include` / `exclude` / meta auto-exclusion rules as
   * the trigger. Returns `null` when the diff is empty (no changes recorded).
   *
   * > ⚠️ Use sparingly — combining manual records with the trigger can
   * > produce duplicate entries if both fire for the same write.
   *
   * @param args - `[...pathArgs, payload]` where `payload` is
   *               `{ operation, before?, after?, meta? }`.
   */
  recordManual(
    ...args: [
      ...PathArgs,
      {
        operation: HistoryOperation;
        before?: T | null;
        after?: T | null;
        meta?: HistoryMeta;
      },
    ]
  ): Promise<HistoryEntry<T> | null>;
}
