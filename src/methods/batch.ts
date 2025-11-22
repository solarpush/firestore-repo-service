import type { Firestore, WriteBatch } from "firebase-admin/firestore";

/**
 * Creates batch operation methods
 */
export function createBatchMethods(
  db: Firestore,
  documentRef: (...args: any[]) => any
) {
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
          batch.set(docRef, data, mergeOption);
        },
        update: (...args: any[]) => {
          const data = args.pop();
          const pathArgs = args;
          const docRef = documentRef(...pathArgs);
          batch.update(docRef, data);
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
