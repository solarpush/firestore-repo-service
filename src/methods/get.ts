import type {
  CollectionReference,
  DocumentReference,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { capitalize, chunkArray } from "../shared/utils";

/**
 * Injects auto-generated fields into the result
 */
function injectAutoFields<T>(
  data: any,
  docRef: DocumentReference,
  autoFields?: { [K in keyof T]?: (docRef: DocumentReference) => T[K] }
): T {
  const result = { ...data };

  if (autoFields) {
    for (const field in autoFields) {
      const generator = autoFields[field as keyof T];
      if (generator) {
        result[field] = generator(docRef);
      }
    }
  }

  return result as T;
}

/**
 * Creates get.by* methods for foreign keys
 */
export function createGetMethods<T>(
  collectionRef: Query,
  foreignKeys: readonly string[],
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => DocumentReference,
  autoFields?: { [K in keyof T]?: (docRef: DocumentReference) => T[K] }
) {
  const getMethods: any = {};

  // get.byList - retrieve multiple documents by list of values
  getMethods.byList = async (
    key: string,
    values: any[],
    operator: "in" | "array-contains-any" = "in",
    returnDoc = false
  ): Promise<T[]> => {
    if (values.length === 0) return [];

    const results: T[] = [];
    const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

    for (const chunk of chunks) {
      let q: Query = collectionRef as any;
      q = q.where(key, operator, chunk);
      const snapshot: QuerySnapshot = await q.get();

      snapshot.forEach((doc) => {
        const data = doc.data();
        results.push(
          returnDoc
            ? { data, doc }
            : injectAutoFields<T>(data, doc.ref, autoFields)
        );
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
    ): Promise<T | null> => {
      // Special case: if foreignKey is "docId" or "documentId", use direct document reference
      if (
        String(foreignKey) === "docId" ||
        String(foreignKey) === "documentId"
      ) {
        const docRef = documentRef(value);
        const doc = await docRef.get();
        if (!doc.exists) return null;
        const data = doc.data();
        return returnDoc
          ? { data, doc }
          : injectAutoFields<T>(data, doc.ref, autoFields);
      }

      // For other keys, query by field value
      let q: Query = collectionRef as any;
      q = q.where(String(foreignKey), "==", value).limit(1);
      const snapshot: QuerySnapshot = await q.get();
      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      if (!doc) return null;
      const data = doc.data();
      return returnDoc
        ? { data, doc }
        : injectAutoFields<T>(data, doc.ref, autoFields);
    };
  });

  return getMethods;
}
