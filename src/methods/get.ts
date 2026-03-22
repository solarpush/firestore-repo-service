import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import type { GetOptions } from "../shared/types";
import { capitalize, chunkArray } from "../shared/utils";

/**
 * Creates get.by* methods for foreign keys.
 * These methods return a single document or null.
 *
 * @template T - The document type
 * @param collectionRef - Firestore query reference
 * @param foreignKeys - Array of field names to generate get methods for
 * @param actualCollection - The actual collection reference (null for collection groups)
 * @param documentRef - Function to create document references
 * @param documentKey - The field name used as document ID
 * @returns Object containing generated get methods
 *
 * @example
 * ```typescript
 * // Generated methods based on foreignKeys: ["docId", "email", "slug"]
 *
 * // Basic usage - get user by docId
 * const user = await repos.users.get.byDocId("user-123");
 *
 * // Get user by email
 * const userByEmail = await repos.users.get.byEmail("john@example.com");
 *
 * // With select - only return specific fields
 * const partialUser = await repos.users.get.byDocId("user-123", {
 *   select: ["name", "email"]
 * });
 *
 * // With returnDoc - get both data and Firestore DocumentSnapshot
 * const { data, doc } = await repos.users.get.byDocId("user-123", {
 *   returnDoc: true
 * });
 * console.log("Document path:", doc.ref.path);
 *
 * // Get multiple documents by list of values
 * const users = await repos.users.get.byList("docId", ["user-1", "user-2", "user-3"]);
 *
 * // Get by list with array-contains-any operator
 * const usersWithTags = await repos.users.get.byList(
 *   "tags",
 *   ["admin", "moderator"],
 *   "array-contains-any"
 * );
 * ```
 */
export function createGetMethods<T>(
  collectionRef: Query,
  foreignKeys: readonly string[],
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => DocumentReference,
  documentKey: string,
) {
  const getMethods: any = {};

  // get.byList - retrieve multiple documents by list of values
  getMethods.byList = async (
    key: string,
    values: any[],
    operator: "in" | "array-contains-any" = "in",
    options: GetOptions = {},
  ): Promise<T[] | { data: T; doc: DocumentSnapshot }[]> => {
    if (values.length === 0) return [];

    const results: (T | { data: T; doc: DocumentSnapshot })[] = [];
    const chunks = chunkArray(values, 30); // Firestore limits 'in' to 30 elements

    for (const chunk of chunks) {
      let q: Query = collectionRef as any;
      q = q.where(key, operator, chunk);

      // Apply select if specified
      if (options.select && options.select.length > 0) {
        q = q.select(...options.select.map((f) => String(f)));
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
      options: GetOptions | boolean = {},
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
        q = q.select(...opts.select.map((f) => String(f)));
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
