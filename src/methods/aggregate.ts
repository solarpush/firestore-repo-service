import type { Query } from "firebase-admin/firestore";
import type { QueryOptions } from "../shared/types";
import { applyQueryOptions } from "./query";

/**
 * Creates aggregate methods for server-side computations
 */
export function createAggregateMethods(collectionRef: Query) {
  return {
    // Count documents matching query options
    count: async (options: QueryOptions = {}): Promise<number> => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);
      const snapshot = await q.count().get();
      return snapshot.data().count;
    },

    // Sum of a numeric field
    sum: async (field: string, options: QueryOptions = {}): Promise<number> => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);
      const snapshot = await q.get();

      let total = 0;
      snapshot.forEach((doc) => {
        const value = doc.data()[field];
        if (typeof value === "number") {
          total += value;
        }
      });

      return total;
    },

    // Average of a numeric field
    average: async (
      field: string,
      options: QueryOptions = {}
    ): Promise<number | null> => {
      let q: Query = collectionRef as any;
      q = applyQueryOptions(q, options);
      const snapshot = await q.get();

      if (snapshot.empty) return null;

      let total = 0;
      let count = 0;

      snapshot.forEach((doc) => {
        const value = doc.data()[field];
        if (typeof value === "number") {
          total += value;
          count++;
        }
      });

      return count > 0 ? total / count : null;
    },
  };
}
