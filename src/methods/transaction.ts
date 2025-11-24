import type { Firestore } from "firebase-admin/firestore";

/**
 * Creates transaction operation methods
 */
export function createTransactionMethods(
  db: Firestore,
  documentRef: (...args: any[]) => any
) {
  return {
    run: async <R>(
      updateFunction: (transaction: any) => Promise<R>
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
