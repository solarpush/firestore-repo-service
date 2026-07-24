import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { maybeNormalize } from "../shared/date-config";
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
        const data = maybeNormalize(doc.data()) as T;
        results.push(options.returnDoc ? { data, doc } : data);
      });
    }

    return results as T[] | { data: T; doc: DocumentSnapshot }[];
  };

  // Generate get.by* methods for each foreign key
  foreignKeys.forEach((foreignKey: string) => {
    const methodName = `by${capitalize(String(foreignKey))}`;
    getMethods[methodName] = async (
      ...args: any[]
    ): Promise<T | { data: T; doc: DocumentSnapshot } | null> => {
      let options: GetOptions = {};
      const lastArg = args[args.length - 1];
      if (typeof lastArg === "boolean") {
        options = { returnDoc: lastArg };
        args = args.slice(0, -1);
      } else if (
        typeof lastArg === "object" &&
        lastArg !== null &&
        !Array.isArray(lastArg)
      ) {
        options = lastArg;
        args = args.slice(0, -1);
      }

      // Special case: if foreignKey is the documentKey
      if (String(foreignKey) === documentKey) {
        // Direct document reference works if:
        // - explicit parent path arguments are provided (args.length > 1)
        // - OR it's a regular root collection (actualCollection !== null) AND args.length === 1
        if (
          args.length > 1 ||
          (args.length === 1 && actualCollection !== null)
        ) {
          const docRef = documentRef(...args);
          const doc = await docRef.get();
          if (!doc.exists) return null;
          const data = maybeNormalize(doc.data()) as T;
          return options.returnDoc ? { data, doc } : data;
        }
      }

      // Fallback or other foreign keys: query via collectionRef (collectionGroup query for isGroup: true)
      const value = args[0];
      if (value === undefined) return null;

      let q: Query = collectionRef as any;
      q = q.where(String(foreignKey), "==", value).limit(1);

      // Apply select if specified
      if (options.select && options.select.length > 0) {
        q = q.select(...options.select.map((f) => String(f)));
      }

      const snapshot: QuerySnapshot = await q.get();
      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      if (!doc) return null;
      const data = maybeNormalize(doc.data()) as T;
      return options.returnDoc ? { data, doc } : data;
    };
  });

  return getMethods;
}
