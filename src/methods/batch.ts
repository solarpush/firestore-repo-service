import type { Firestore, WriteBatch } from "firebase-admin/firestore";

/**
 * Creates batch operation methods for atomic writes (max 500 operations).
 * All operations in a batch either succeed or fail together.
 *
 * @param db - Firestore database instance
 * @param documentRef - Function to create document references
 * @param documentKey - The field name used as document ID
 * @param pathKey - Optional field name to store the document path
 * @param createdKey - Optional field name for creation timestamp
 * @param updatedKey - Optional field name for update timestamp
 * @returns Object containing batch creation method
 *
 * @example
 * ```typescript
 * // Create a batch for atomic operations
 * const batch = repos.users.batch.create();
 *
 * // SET - Add multiple documents
 * batch.set("user-1", { name: "Alice", email: "alice@example.com" });
 * batch.set("user-2", { name: "Bob", email: "bob@example.com" });
 * batch.set("user-3", { name: "Charlie", email: "charlie@example.com" });
 *
 * // For subcollections (e.g., posts/{postId}/comments/{commentId}):
 * const commentBatch = repos.comments.batch.create();
 * commentBatch.set("post-1", "comment-1", { content: "First comment" });
 * commentBatch.set("post-1", "comment-2", { content: "Second comment" });
 *
 * // UPDATE - Update existing documents in batch
 * batch.update("user-1", { name: "Alice Updated" });
 * batch.update("user-2", { age: 30 });
 *
 * // DELETE - Delete documents in batch
 * batch.delete("user-3");
 *
 * // COMMIT - Execute all operations atomically
 * await batch.commit();
 *
 * // With merge option (default: true)
 * batch.set("user-4", { name: "David" }, { merge: false }); // Overwrites entirely
 *
 * // Full example with mixed operations
 * const orderBatch = repos.orders.batch.create();
 * orderBatch.set("order-new", { status: "pending", total: 99.99 });
 * orderBatch.update("order-old", { status: "completed" });
 * orderBatch.delete("order-cancelled");
 * await orderBatch.commit(); // All or nothing
 * ```
 */
export function createBatchMethods(
  db: Firestore,
  documentRef: (...args: any[]) => any,
  documentKey: string,
  pathKey?: string,
  createdKey?: string,
  updatedKey?: string,
) {
  const now = () => new Date();

  return {
    create: () => {
      const batch: WriteBatch = db.batch();
      return {
        batch,
        set: (...args: any[]) => {
          const lastArg = args[args.length - 1];
          const hasOptions =
            typeof lastArg === "object" &&
            lastArg !== null &&
            "merge" in lastArg;

          const data = hasOptions
            ? args[args.length - 2]
            : args[args.length - 1];
          const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
          const mergeOption = hasOptions ? lastArg : { merge: true };

          const docRef = documentRef(...pathArgs);

          // Auto-populate documentKey, pathKey, createdKey and updatedKey
          const enrichedData = { ...data };
          // Use the last pathArg as documentKey (for subcollections, first args are parent IDs)
          const docIdValue = pathArgs[pathArgs.length - 1];
          if (documentKey && docIdValue) {
            enrichedData[documentKey] = docIdValue;
          }
          if (pathKey) {
            enrichedData[pathKey] = docRef.path;
          }
          if (createdKey) {
            enrichedData[createdKey] = now();
          }
          if (updatedKey) {
            enrichedData[updatedKey] = now();
          }

          batch.set(docRef, enrichedData, mergeOption);
        },
        update: (...args: any[]) => {
          const data = args.pop();
          const pathArgs = args;
          const docRef = documentRef(...pathArgs);

          // Auto-set updatedKey
          const enrichedData = { ...data };
          if (updatedKey) {
            enrichedData[updatedKey] = now();
          }

          batch.update(docRef, enrichedData);
        },
        delete: (...args: any[]) => {
          const docRef = documentRef(...args);
          batch.delete(docRef);
        },
        commit: async () => {
          await batch.commit();
        },
      };
    },
  };
}
