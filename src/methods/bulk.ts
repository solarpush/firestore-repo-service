import type { DocumentReference, Firestore } from "firebase-admin/firestore";

/**
 * Creates bulk operation methods using BulkWriter
 */
export function createBulkMethods(db: Firestore) {
  return {
    // Set multiple documents with automatic batching (500 ops per flush)
    set: async (
      items: Array<{
        docRef: DocumentReference;
        data: any;
        merge?: boolean;
      }>
    ) => {
      const bulkWriter = db.bulkWriter();
      let pendingOps = 0;

      for (const item of items) {
        if (!item) continue;
        const { docRef, data, merge = true } = item;
        bulkWriter.set(docRef, data, { merge });
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
        bulkWriter.update(docRef, data);
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
