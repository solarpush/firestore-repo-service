import type { Query } from "firebase-admin/firestore";
import type { QueryOptions } from "../shared/types";
import { applyQueryOptions } from "../shared/utils";

/**
 * Creates aggregate methods for server-side computations.
 * These operations are executed on the Firestore server for optimal performance.
 *
 * @param collectionRef - Firestore query reference
 * @returns Object containing aggregate methods (count, sum, average)
 *
 * @example
 * ```typescript
 * // COUNT - Count all documents
 * const totalUsers = await repos.users.aggregate.count();
 *
 * // Count with filter
 * const activeUsers = await repos.users.aggregate.count({
 *   where: [["isActive", "==", true]]
 * });
 *
 * // Count with complex filters
 * const premiumActiveUsers = await repos.users.aggregate.count({
 *   where: [
 *     ["isActive", "==", true],
 *     ["subscription", "==", "premium"]
 *   ]
 * });
 *
 * // SUM - Sum of a numeric field
 * const totalRevenue = await repos.orders.aggregate.sum("amount");
 *
 * // Sum with filter
 * const monthlyRevenue = await repos.orders.aggregate.sum("amount", {
 *   where: [
 *     ["createdAt", ">=", startOfMonth],
 *     ["createdAt", "<=", endOfMonth]
 *   ]
 * });
 *
 * // AVERAGE - Average of a numeric field
 * const avgOrderValue = await repos.orders.aggregate.average("amount");
 *
 * // Average with filter
 * const avgPremiumOrder = await repos.orders.aggregate.average("amount", {
 *   where: [["customerType", "==", "premium"]]
 * });
 *
 * // Returns null if no matching documents
 * const avgEmpty = await repos.orders.aggregate.average("amount", {
 *   where: [["status", "==", "nonexistent"]]
 * }); // null
 *
 * // Combine multiple aggregations
 * const [total, sum, avg] = await Promise.all([
 *   repos.orders.aggregate.count(),
 *   repos.orders.aggregate.sum("amount"),
 *   repos.orders.aggregate.average("amount")
 * ]);
 * console.log(`${total} orders, $${sum} total, $${avg} average`);
 * ```
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
      options: QueryOptions = {},
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
