import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { capitalize, chunkArray } from "../shared/utils";

/**
 * Options for get methods
 */
export interface GetOptions {
  /** Fields to select (Firestore select) - reduces network transfer */
  select?: string[];
  /** Return the document snapshot along with data */
  returnDoc?: boolean;
}

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
    options: GetOptions = {}
  ): Promise<T[] | { data: T; doc: DocumentSnapshot }[]> => {
    if (values.length === 0) return [];

    const results: (T | { data: T; doc: DocumentSnapshot })[] = [];
    const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

    for (const chunk of chunks) {
      let q: Query = collectionRef as any;
      q = q.where(key, operator, chunk);

      // Apply select if specified
      if (options.select && options.select.length > 0) {
        q = q.select(...options.select);
      }

      const snapshot: QuerySnapshot = await q.get();

      snapshot.forEach((doc) => {
        const data = doc.data() as T;
        results.push(options.returnDoc ? { data, doc } : data);
      });
    }

    return results as T[] | { data: T; doc: DocumentSnapshot }[];
  };

  // Generate get.by* methods for each foreign key
  foreignKeys.forEach((foreignKey: string) => {
    const methodName = `by${capitalize(String(foreignKey))}`;
    getMethods[methodName] = async (
      value: string,
      options: GetOptions | boolean = {}
    ): Promise<T | { data: T; doc: DocumentSnapshot } | null> => {
      // Handle legacy boolean returnDoc parameter
      const opts: GetOptions =
        typeof options === "boolean" ? { returnDoc: options } : options;

      // Special case: if foreignKey is the documentKey, use direct document reference
      if (String(foreignKey) === documentKey) {
        const docRef = documentRef(value);
        const doc = await docRef.get();
        if (!doc.exists) return null;
        const data = doc.data() as T;
        return opts.returnDoc ? { data, doc } : data;
      }

      // For other keys, query by field value
      let q: Query = collectionRef as any;
      q = q.where(String(foreignKey), "==", value).limit(1);

      // Apply select if specified
      if (opts.select && opts.select.length > 0) {
        q = q.select(...opts.select);
      }

      const snapshot: QuerySnapshot = await q.get();
      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      if (!doc) return null;
      const data = doc.data() as T;
      return opts.returnDoc ? { data, doc } : data;
    };
  });

  return getMethods;
}
