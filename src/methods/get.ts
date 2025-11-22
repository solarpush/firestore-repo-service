import type { Query, QuerySnapshot } from "firebase-admin/firestore";
import { capitalize, chunkArray } from "../shared/utils";

/**
 * Creates get.by* methods for foreign keys
 */
export function createGetMethods(
  collectionRef: Query,
  foreignKeys: readonly string[]
) {
  const getMethods: any = {};

  // get.byList - retrieve multiple documents by list of values
  getMethods.byList = async (
    key: string,
    values: any[],
    operator: "in" | "array-contains-any" = "in",
    returnDoc = false
  ): Promise<any[]> => {
    if (values.length === 0) return [];

    const results: any[] = [];
    const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

    for (const chunk of chunks) {
      let q: Query = collectionRef as any;
      q = q.where(key, operator, chunk);
      const snapshot: QuerySnapshot = await q.get();

      snapshot.forEach((doc) => {
        const data = doc.data();
        results.push(returnDoc ? { data, doc } : { ...data, docId: doc.id });
      });
    }

    return results;
  };

  // Generate get.by* methods for each foreign key
  foreignKeys.forEach((foreignKey: string) => {
    const methodName = `by${capitalize(String(foreignKey))}`;
    getMethods[methodName] = async (
      value: string,
      returnDoc = false
    ): Promise<any | null> => {
      let q: Query = collectionRef as any;
      q = q.where(String(foreignKey), "==", value).limit(1);
      const snapshot: QuerySnapshot = await q.get();
      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      if (!doc) return null;
      const data = doc.data();
      return returnDoc ? { data, doc } : { ...data, docId: doc.id };
    };
  });

  return getMethods;
}
