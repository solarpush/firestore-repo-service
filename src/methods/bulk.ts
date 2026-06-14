import type { DocumentReference, Firestore } from "firebase-admin/firestore";

/**
 * Per-document failure collected from a bulk operation. `ref` is the document
 * reference that could not be written, `error` the last error returned by
 * Firestore for it.
 */
export interface BulkFailure {
  ref: DocumentReference;
  error: Error;
}

/** Result returned by every `bulk.*` method. */
export interface BulkResult {
  /** Documents that ultimately failed (after retries). Empty on full success. */
  failures: BulkFailure[];
}

/**
 * Options accepted by every `bulk.*` method.
 *
 * When `onError` is provided the operation is considered observable and does
 * **not** throw on partial failure — inspect {@link BulkResult.failures}
 * instead. When `onError` is omitted, a partial failure throws (preserving the
 * historical fail-loud behaviour) after the writer has drained.
 */
export interface BulkOptions {
  /** Called once per document that fails permanently (after retries). */
  onError?: (failure: BulkFailure) => void;
  /** Called once per document that succeeds. */
  onSuccess?: (ref: DocumentReference) => void;
  /** Max attempts per document for retryable errors. Default: 5. */
  maxAttempts?: number;
}

/** gRPC status codes that are safe to retry (matches BulkWriter defaults). */
const RETRYABLE_CODES = new Set([
  4, // DEADLINE_EXCEEDED
  8, // RESOURCE_EXHAUSTED
  10, // ABORTED
  13, // INTERNAL
  14, // UNAVAILABLE
]);

/**
 * Wire `onWriteError` / `onWriteResult` on a BulkWriter so partial failures
 * are observable: retryable errors are retried up to `maxAttempts`, the rest
 * are collected (issue #10). Returns the live failures array.
 */
function instrumentWriter(
  bulkWriter: ReturnType<Firestore["bulkWriter"]>,
  opts: BulkOptions,
): BulkFailure[] {
  const failures: BulkFailure[] = [];
  const maxAttempts = opts.maxAttempts ?? 5;

  bulkWriter.onWriteError((err: any) => {
    const code = err?.code as number | undefined;
    if (
      err.failedAttempts < maxAttempts &&
      code !== undefined &&
      RETRYABLE_CODES.has(code)
    ) {
      return true; // retry
    }
    const failure: BulkFailure = {
      ref: err.documentRef as DocumentReference,
      error: err as Error,
    };
    failures.push(failure);
    opts.onError?.(failure);
    return false; // give up on this document, keep the rest going
  });

  if (opts.onSuccess) {
    bulkWriter.onWriteResult((ref: DocumentReference) => opts.onSuccess!(ref));
  }

  return failures;
}

/**
 * After the writer drains, surface failures: when the caller registered an
 * `onError` handler they own error handling, so just return them; otherwise
 * throw to preserve the historical fail-loud contract.
 */
function finalize(failures: BulkFailure[], opts: BulkOptions): BulkResult {
  if (failures.length > 0 && !opts.onError) {
    const err = new Error(
      `bulk operation failed for ${failures.length} document(s): ` +
        failures
          .slice(0, 5)
          .map((f) => `${f.ref.path} (${f.error.message})`)
          .join("; "),
    );
    (err as Error & { failures: BulkFailure[] }).failures = failures;
    throw err;
  }
  return { failures };
}

/**
 * Creates bulk operation methods using BulkWriter for large-scale operations.
 *
 * The BulkWriter handles its own adaptive batching and throttling, so the
 * methods no longer call `flush()` manually (that defeated the adaptive rate
 * control). Partial failures are observable via `onError`/`onSuccess` and the
 * returned {@link BulkResult.failures}.
 *
 * @param db - Firestore database instance
 * @param createdKey - Optional field name for creation timestamp
 * @param updatedKey - Optional field name for update timestamp
 * @returns Object containing bulk write methods
 *
 * @example
 * ```typescript
 * // BULK SET - Create/update thousands of documents efficiently
 * const items = users.map(user => ({
 *   docRef: db.collection("users").doc(user.id),
 *   data: { name: user.name, email: user.email },
 *   merge: true // Optional, defaults to true
 * }));
 *
 * await repos.users.bulk.set(items);
 *
 * // Observe partial failures (does not throw — inspect failures):
 * const { failures } = await repos.users.bulk.set(items, {
 *   onError: ({ ref, error }) => console.error(ref.path, error.message),
 *   onSuccess: (ref) => metrics.inc("migrated"),
 * });
 * if (failures.length) await retryLater(failures.map((f) => f.ref));
 *
 * // Note: Unlike batch, bulk operations are NOT atomic.
 * // Each write is independent - some may succeed while others fail.
 * // Use batch for atomic operations (max 500), bulk for large datasets.
 * ```
 */
export function createBulkMethods(
  db: Firestore,
  createdKey?: string,
  updatedKey?: string,
) {
  const now = () => new Date();

  return {
    // Set multiple documents (BulkWriter handles batching/throttling).
    set: async (
      items: Array<{
        docRef: DocumentReference;
        data: any;
        merge?: boolean;
      }>,
      opts: BulkOptions = {},
    ): Promise<BulkResult> => {
      const bulkWriter = db.bulkWriter();
      const failures = instrumentWriter(bulkWriter, opts);

      for (const item of items) {
        if (!item) continue;
        const { docRef, data, merge = true } = item;

        // Auto-set createdKey and updatedKey
        const enrichedData = { ...data };
        if (createdKey) {
          enrichedData[createdKey] = now();
        }
        if (updatedKey) {
          enrichedData[updatedKey] = now();
        }

        void bulkWriter.set(docRef, enrichedData, { merge });
      }

      await bulkWriter.close();
      return finalize(failures, opts);
    },

    // Update multiple documents.
    update: async (
      items: Array<{ docRef: DocumentReference; data: any }>,
      opts: BulkOptions = {},
    ): Promise<BulkResult> => {
      const bulkWriter = db.bulkWriter();
      const failures = instrumentWriter(bulkWriter, opts);

      for (const item of items) {
        if (!item) continue;
        const { docRef, data } = item;

        // Auto-set updatedKey
        const enrichedData = { ...data };
        if (updatedKey) {
          enrichedData[updatedKey] = now();
        }

        void bulkWriter.update(docRef, enrichedData);
      }

      await bulkWriter.close();
      return finalize(failures, opts);
    },

    // Delete multiple documents.
    delete: async (
      docRefs: DocumentReference[],
      opts: BulkOptions = {},
    ): Promise<BulkResult> => {
      const bulkWriter = db.bulkWriter();
      const failures = instrumentWriter(bulkWriter, opts);

      for (const docRef of docRefs) {
        if (!docRef) continue;
        void bulkWriter.delete(docRef);
      }

      await bulkWriter.close();
      return finalize(failures, opts);
    },
  };
}
