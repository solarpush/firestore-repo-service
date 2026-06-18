import {
  type CollectionReference,
  FieldPath,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

/** Per-document failure surfaced by a system maintenance operation. */
export interface SystemBackfillFailure {
  path: string;
  error: Error;
}

/** Result returned by {@link SystemMethods.backfillKeys}. */
export interface SystemBackfillResult {
  /** Documents inspected. */
  scanned: number;
  /** Documents that actually needed (and received) a patch. */
  written: number;
  /** Documents skipped because every managed key was already present. */
  skipped: number;
  /** Per-document permanent failures (after retries). Empty on full success. */
  failures: SystemBackfillFailure[];
}

/** Options accepted by {@link SystemMethods.backfillKeys}. */
export interface SystemBackfillOptions {
  /**
   * Overwrite `createdKey` even when already present. Default `false` —
   * existing creation timestamps are preserved.
   */
  overwriteCreated?: boolean;
  /**
   * Set `updatedKey` to now when missing. Existing values are preserved.
   * Default `true`.
   */
  touchUpdated?: boolean;
  /**
   * Always rewrite `pathKey` from the document's live reference path, even if
   * a value is already stored. Default `false` — only filled when missing.
   */
  overwritePath?: boolean;
  /** Page size used to stream the collection. Default `300`. */
  pageSize?: number;
  /** Inspect and count only, without writing. Default `false`. */
  dryRun?: boolean;
  /** Called once per document that fails permanently (after retries). */
  onError?: (failure: SystemBackfillFailure) => void;
  /** Called once per document successfully patched. */
  onSuccess?: (path: string) => void;
  /** Max attempts per document for retryable errors. Default `5`. */
  maxAttempts?: number;
}

/** gRPC status codes that are safe to retry (matches BulkWriter defaults). */
const RETRYABLE_CODES = new Set([4, 8, 10, 13, 14]);

export interface SystemMethods {
  backfillKeys: (
    options?: SystemBackfillOptions,
  ) => Promise<SystemBackfillResult>;
}

/**
 * Maintenance helpers that operate on the whole collection.
 *
 * `backfillKeys` streams every document and fills the auto-managed system
 * fields (`documentKey`, `pathKey`, `createdKey`, `updatedKey`) on legacy
 * documents that were written outside this package. It is idempotent and only
 * writes documents that are actually missing one of those fields, so it is safe
 * to run repeatedly. The live `doc.ref.path` is authoritative for `pathKey`,
 * which means subcollection / collectionGroup documents get the **full** nested
 * path — exactly what the CRUD/admin server handlers need to update or delete
 * them later.
 *
 * @param db - Firestore database instance
 * @param collectionRef - Collection or collectionGroup query to scan
 * @param documentKey - Field name used as document ID
 * @param pathKey - Optional field name storing the document path
 * @param createdKey - Optional field name for the creation timestamp
 * @param updatedKey - Optional field name for the update timestamp
 *
 * @example
 * ```typescript
 * // Backfill documentPath + createdAt/updatedAt on legacy docs.
 * const { scanned, written, failures } = await repos.residences.system.backfillKeys();
 *
 * // Preview without writing:
 * const preview = await repos.residences.system.backfillKeys({ dryRun: true });
 * ```
 */
export function createSystemMethods(
  db: Firestore,
  collectionRef: CollectionReference | Query,
  documentKey: string,
  pathKey?: string,
  createdKey?: string,
  updatedKey?: string,
): SystemMethods {
  const now = () => new Date();

  const backfillKeys = async (
    options: SystemBackfillOptions = {},
  ): Promise<SystemBackfillResult> => {
    const {
      overwriteCreated = false,
      touchUpdated = true,
      overwritePath = false,
      pageSize = 300,
      dryRun = false,
      maxAttempts = 5,
      onError,
      onSuccess,
    } = options;

    const failures: SystemBackfillFailure[] = [];
    let scanned = 0;
    let written = 0;
    let skipped = 0;

    const bulkWriter = dryRun ? null : db.bulkWriter();
    if (bulkWriter) {
      bulkWriter.onWriteError((err: any) => {
        const code = err?.code as number | undefined;
        if (
          err.failedAttempts < maxAttempts &&
          code !== undefined &&
          RETRYABLE_CODES.has(code)
        ) {
          return true;
        }
        const failure: SystemBackfillFailure = {
          path: err?.documentRef?.path ?? "(unknown)",
          error: err as Error,
        };
        failures.push(failure);
        onError?.(failure);
        return false;
      });
      if (onSuccess) {
        bulkWriter.onWriteResult((ref) => onSuccess(ref.path));
      }
    }

    // Stream the collection ordered by document id so pagination works for
    // both plain collections and collectionGroup queries.
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let pageQuery: Query = (collectionRef as Query).orderBy(
        FieldPath.documentId(),
      );
      if (cursor) pageQuery = pageQuery.startAfter(cursor);
      pageQuery = pageQuery.limit(pageSize);

      const snapshot = await pageQuery.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        scanned++;
        const data = doc.data();
        const patch: Record<string, unknown> = {};

        if (documentKey && data[documentKey] == null) {
          patch[documentKey] = doc.id;
        }
        if (pathKey && (overwritePath || data[pathKey] == null)) {
          if (data[pathKey] !== doc.ref.path) patch[pathKey] = doc.ref.path;
        }
        if (createdKey && (overwriteCreated || data[createdKey] == null)) {
          patch[createdKey] = now();
        }
        if (touchUpdated && updatedKey && data[updatedKey] == null) {
          patch[updatedKey] = now();
        }

        if (Object.keys(patch).length === 0) {
          skipped++;
          continue;
        }

        written++;
        if (bulkWriter) {
          void bulkWriter.set(doc.ref, patch, { merge: true });
        }
      }

      if (snapshot.size < pageSize) break;
      cursor = snapshot.docs[snapshot.docs.length - 1];
    }

    if (bulkWriter) await bulkWriter.close();

    return { scanned, written, skipped, failures };
  };

  return { backfillKeys };
}
