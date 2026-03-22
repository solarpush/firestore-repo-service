import type { DocumentReference, Firestore } from "firebase-admin/firestore";

/**
 * Creates bulk operation methods using BulkWriter for large-scale operations.
 * Automatically handles batching (flushes every 500 operations) and provides
 * better performance for large datasets than regular batches.
 *
 * @param db - Firestore database instance
 * @param createdKey - Optional field name for creation timestamp
 * @param updatedKey - Optional field name for update timestamp
 * @returns Object containing bulk write methods
 *
 * @example
 * ```typescript
 * // BULK SET - Create/update thousands of documents efficiently
 * // Prepare items with document references
 * const items = users.map(user => ({
 *   docRef: db.collection("users").doc(user.id),
 *   data: { name: user.name, email: user.email },
 *   merge: true // Optional, defaults to true
 * }));
 *
 * await repos.users.bulk.set(items);
 *
 * // BULK UPDATE - Update many documents
 * const updates = [
 *   { docRef: db.collection("users").doc("user-1"), data: { status: "active" } },
 *   { docRef: db.collection("users").doc("user-2"), data: { status: "active" } },
 *   // ... thousands more
 * ];
 *
 * await repos.users.bulk.update(updates);
 *
 * // BULK DELETE - Delete many documents
 * const docsToDelete = [
 *   db.collection("users").doc("user-1"),
 *   db.collection("users").doc("user-2"),
 *   // ... thousands more
 * ];
 *
 * await repos.users.bulk.delete(docsToDelete);
 *
 * // Practical example: Migrate data
 * const allUsers = await repos.users.query.getAll();
 * const bulkItems = allUsers.map(user => ({
 *   docRef: db.collection("users").doc(user.docId),
 *   data: { ...user, migrated: true, version: 2 }
 * }));
 * await repos.users.bulk.set(bulkItems);
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
    // Set multiple documents with automatic batching (500 ops per flush)
    set: async (
      items: Array<{
        docRef: DocumentReference;
        data: any;
        merge?: boolean;
      }>,
    ) => {
      const bulkWriter = db.bulkWriter();
      let pendingOps = 0;

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

        bulkWriter.set(docRef, enrichedData, { merge });
        pendingOps++;

        if (pendingOps >= 500) {
          await bulkWriter.flush();
          pendingOps = 0;
        }
      }

      await bulkWriter.close();
    },

    // Update multiple documents with automatic batching
    update: async (items: Array<{ docRef: DocumentReference; data: any }>) => {
      const bulkWriter = db.bulkWriter();
      let pendingOps = 0;

      for (const item of items) {
        if (!item) continue;
        const { docRef, data } = item;

        // Auto-set updatedKey
        const enrichedData = { ...data };
        if (updatedKey) {
          enrichedData[updatedKey] = now();
        }

        bulkWriter.update(docRef, enrichedData);
        pendingOps++;

        if (pendingOps >= 500) {
          await bulkWriter.flush();
          pendingOps = 0;
        }
      }

      await bulkWriter.close();
    },

    // Delete multiple documents with automatic batching
    delete: async (docRefs: DocumentReference[]) => {
      const bulkWriter = db.bulkWriter();
      let pendingOps = 0;

      for (const docRef of docRefs) {
        if (!docRef) continue;
        bulkWriter.delete(docRef);
        pendingOps++;

        if (pendingOps >= 500) {
          await bulkWriter.flush();
          pendingOps = 0;
        }
      }

      await bulkWriter.close();
    },
  };
}
