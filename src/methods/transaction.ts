import type { Firestore } from "firebase-admin/firestore";

/**
 * Creates transaction operation methods for atomic read-write operations.
 * Transactions ensure consistency when reading and writing data atomically.
 *
 * @param db - Firestore database instance
 * @param documentRef - Function to create document references
 * @returns Object containing the transaction run method
 *
 * @example
 * ```typescript
 * // Basic transaction - transfer points between users
 * const result = await repos.users.transaction.run(async (tx) => {
 *   // Read both users
 *   const sender = await tx.get("sender-id");
 *   const receiver = await tx.get("receiver-id");
 *
 *   if (!sender || sender.points < 100) {
 *     throw new Error("Insufficient points");
 *   }
 *
 *   // Update both atomically
 *   tx.update("sender-id", { points: sender.points - 100 });
 *   tx.update("receiver-id", { points: (receiver?.points || 0) + 100 });
 *
 *   return { transferred: 100 };
 * });
 *
 * // Transaction with subcollections
 * await repos.comments.transaction.run(async (tx) => {
 *   // Get comment from subcollection (postId, commentId)
 *   const comment = await tx.get("post-123", "comment-456");
 *
 *   // Update the comment
 *   tx.update("post-123", "comment-456", {
 *     likes: (comment?.likes || 0) + 1
 *   });
 * });
 *
 * // Transaction with set and delete
 * await repos.orders.transaction.run(async (tx) => {
 *   const order = await tx.get("order-id");
 *
 *   // Create archive entry
 *   tx.set("archived-order-id", {
 *     ...order,
 *     archivedAt: new Date()
 *   });
 *
 *   // Delete original
 *   tx.delete("order-id");
 * });
 *
 * // Access raw Firestore transaction for advanced use
 * await repos.users.transaction.run(async (tx) => {
 *   // Use raw transaction for cross-collection operations
 *   const rawTx = tx.raw;
 *   const otherDoc = await rawTx.get(db.collection("other").doc("id"));
 *   // ...
 * });
 *
 * // Transaction with merge option
 * await repos.users.transaction.run(async (tx) => {
 *   tx.set("user-id", { lastLogin: new Date() }, { merge: true });
 * });
 * ```
 */
export function createTransactionMethods(
  db: Firestore,
  documentRef: (...args: any[]) => any,
) {
  return {
    run: async <R>(
      updateFunction: (transaction: any) => Promise<R>,
    ): Promise<R> => {
      return db.runTransaction(async (rawTransaction) => {
        const typedTransaction = {
          // Type-safe get method
          get: async (...args: any[]) => {
            const docRef = documentRef(...args);
            const docSnap = (await rawTransaction.get(docRef)) as any;
            if (!docSnap.exists) return null;
            return { ...docSnap.data(), docId: docSnap.id } as any;
          },

          // Type-safe set method
          set: (...args: any[]) => {
            const options = args[args.length - 1];
            const hasOptions =
              typeof options === "object" &&
              options !== null &&
              "merge" in options;

            const data = hasOptions
              ? args[args.length - 2]
              : args[args.length - 1];
            const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
            const mergeOption = hasOptions ? options : { merge: true };

            const docRef = documentRef(...pathArgs);
            rawTransaction.set(docRef, data, mergeOption);
          },

          // Type-safe update method
          update: (...args: any[]) => {
            const data = args[args.length - 1];
            const pathArgs = args.slice(0, -1);
            const docRef = documentRef(...pathArgs);
            rawTransaction.update(docRef, data);
          },

          // Delete method
          delete: (...args: any[]) => {
            const docRef = documentRef(...args);
            rawTransaction.delete(docRef);
          },

          // Access to raw transaction
          raw: rawTransaction,
        };

        return updateFunction(typedTransaction);
      });
    },
  };
}
