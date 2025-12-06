import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { capitalize, chunkArray } from "../shared/utils";

/**
 * Creates get.by* methods for foreign keys
 */
export function createGetMethods<T>(
  collectionRef: Query,
  foreignKeys: readonly string[],
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => DocumentReference,
  documentKey: string
) {
  const getMethods: any = {};

  // get.byList - retrieve multiple documents by list of values
  getMethods.byList = async (
    key: string,
    values: any[],
    operator: "in" | "array-contains-any" = "in",
    returnDoc = false
  ): Promise<T[] | { data: T; doc: DocumentSnapshot }[]> => {
    if (values.length === 0) return [];

    const results: (T | { data: T; doc: DocumentSnapshot })[] = [];
    const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

    for (const chunk of chunks) {
      let q: Query = collectionRef as any;
      q = q.where(key, operator, chunk);
      const snapshot: QuerySnapshot = await q.get();

      snapshot.forEach((doc) => {
        const data = doc.data() as T;
        results.push(returnDoc ? { data, doc } : data);
      });
    }

    return results as T[] | { data: T; doc: DocumentSnapshot }[];
  };

  // Generate get.by* methods for each foreign key
  foreignKeys.forEach((foreignKey: string) => {
    const methodName = `by${capitalize(String(foreignKey))}`;
    getMethods[methodName] = async (
      value: string,
      returnDoc = false
    ): Promise<T | { data: T; doc: DocumentSnapshot } | null> => {
      // Special case: if foreignKey is the documentKey, use direct document reference
      if (String(foreignKey) === documentKey) {
        const docRef = documentRef(value);
        const doc = await docRef.get();
        if (!doc.exists) return null;
        const data = doc.data() as T;
        return returnDoc ? { data, doc } : data;
      }

      // For other keys, query by field value
      let q: Query = collectionRef as any;
      q = q.where(String(foreignKey), "==", value).limit(1);
      const snapshot: QuerySnapshot = await q.get();
      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      if (!doc) return null;
      const data = doc.data() as T;
      return returnDoc ? { data, doc } : data;
    };
  });

  return getMethods;
}
