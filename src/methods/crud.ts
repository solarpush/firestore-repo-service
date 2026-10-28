import type { CollectionReference } from "firebase-admin/firestore";
import { maybeNormalize } from "../shared/date-config";
import {
  extractPathArgsFromDoc,
  generateFirestoreId,
} from "../shared/path-template";

/**
 * Creates CRUD methods (create, set, update, delete).
 *
 * @template T - The document type
 * @param actualCollection - The collection reference (null for collection groups)
 * @param documentRef - Function to create document references
 * @param documentKey - The field name used as document ID
 * @param pathKey - Optional field name to store the document path
 * @param createdKey - Optional field name for creation timestamp
 * @param updatedKey - Optional field name for update timestamp
 * @returns Object containing CRUD methods
 *
 * @example
 * ```typescript
 * // CREATE - Add a new document
 * // Auto-generates docId if not provided, sets createdAt/updatedAt
 * const newUser = await repos.users.create({
 *   name: "John Doe",
 *   email: "john@example.com",
 *   age: 28
 * });
 * console.log(newUser.docId); // Auto-generated ID
 *
 * // Create with custom docId
 * const customUser = await repos.users.create({
 *   docId: "custom-id-123",
 *   name: "Jane Doe",
 *   email: "jane@example.com"
 * });
 *
 * // SET - Create or replace a document by ID
 * // For regular collections:
 * const user = await repos.users.set("user-123", {
 *   name: "Updated Name",
 *   email: "new@example.com"
 * });
 *
 * // For subcollections (e.g., posts/{postId}/comments/{commentId}):
 * const comment = await repos.comments.set("post-123", "comment-456", {
 *   content: "Great post!",
 *   likes: 0
 * });
 *
 * // Set with merge option (default: true)
 * await repos.users.set("user-123", { name: "Only Name" }, { merge: true });
 *
 * // UPDATE - Partially update an existing document
 * const updatedUser = await repos.users.update("user-123", {
 *   name: "New Name"
 * });
 *
 * // Update subcollection document:
 * await repos.comments.update("post-123", "comment-456", {
 *   likes: 10
 * });
 *
 * // DELETE - Remove a document
 * await repos.users.delete("user-123");
 *
 * // Delete subcollection document:
 * await repos.comments.delete("post-123", "comment-456");
 * ```
 */
export function createCrudMethods<T>(
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => any,
  documentKey: string,
  pathKey?: string,
  createdKey?: string,
  updatedKey?: string,
  parentKeys: string[] = [],
  documentPathTemplate?: string | null,
) {
  const now = () => new Date();

  // Create - adds a new document, optionally with a provided document key
  const create = async (...args: any[]): Promise<T> => {
    const data = args[args.length - 1];
    const explicitParentArgs = args.slice(0, -1);

    if (!data || typeof data !== "object") {
      throw new Error("Create data payload must be an object.");
    }

    let docRef: any;
    let docId: string;

    const hasProvidedDocId =
      typeof data[documentKey] === "string" && data[documentKey].trim() !== "";

    // Auto-set createdKey and updatedKey
    const enrichedData = { ...data };
    if (createdKey && enrichedData[createdKey] === undefined) {
      enrichedData[createdKey] = now();
    }
    if (updatedKey) {
      enrichedData[updatedKey] = now();
    }

    if (actualCollection && explicitParentArgs.length === 0) {
      // If documentKey is provided in data, use set() with that ID
      if (hasProvidedDocId) {
        docId = data[documentKey];
        docRef =
          typeof actualCollection.doc === "function"
            ? actualCollection.doc(docId)
            : documentRef(docId);
        enrichedData[documentKey] = docId;
        // Also set pathKey if defined
        const dataWithPath =
          pathKey && docRef?.path
            ? { ...enrichedData, [pathKey]: docRef.path }
            : enrichedData;
        await docRef.set(dataWithPath);
        if (pathKey && docRef?.path) {
          enrichedData[pathKey] = docRef.path;
        }
      } else if (typeof actualCollection.add === "function") {
        // Otherwise, use add() to auto-generate ID
        docRef = await actualCollection.add(enrichedData);
        docId = docRef.id;
        enrichedData[documentKey] = docId;
        // Update the document to include the documentKey and optionally pathKey
        const updates: Record<string, string> = { [documentKey]: docId };
        if (pathKey && docRef?.path) {
          updates[pathKey] = docRef.path;
          enrichedData[pathKey] = docRef.path;
        }
        await docRef.update(updates);
      } else {
        docId = generateFirestoreId();
        docRef =
          typeof actualCollection.doc === "function"
            ? actualCollection.doc(docId)
            : documentRef(docId);
        enrichedData[documentKey] = docRef?.id ?? docId;
        if (pathKey && docRef?.path) {
          enrichedData[pathKey] = docRef.path;
        }
        await docRef.set(enrichedData);
      }
    } else {
      // Subcollection / collection group (actualCollection === null)
      let parentArgs: string[] = [];

      if (explicitParentArgs.length > 0) {
        for (let i = 0; i < explicitParentArgs.length; i++) {
          const val = explicitParentArgs[i];
          if (typeof val !== "string" || val.trim() === "") {
            const keyName = parentKeys[i] ?? `arg[${i}]`;
            throw new Error(
              `Missing or empty parent key "${keyName}" for subcollection create()`,
            );
          }
          parentArgs.push(val);
        }
      } else if (parentKeys.length > 0) {
        const missingKeys: string[] = [];
        for (const pk of parentKeys) {
          const val = data[pk];
          if (typeof val === "string" && val.trim() !== "") {
            parentArgs.push(val);
          } else {
            missingKeys.push(pk);
          }
        }
        if (missingKeys.length > 0) {
          const fromPath = extractPathArgsFromDoc(data, {
            pathKey,
            documentKey,
            parentKeys,
            documentPathTemplate,
            isGroup: true,
          });
          if (fromPath && fromPath.length >= parentKeys.length) {
            parentArgs = fromPath.slice(0, parentKeys.length);
          } else {
            throw new Error(
              `Missing or empty required parent key(s) in data for subcollection create(): ${missingKeys.join(", ")}`,
            );
          }
        }
      } else if (
        pathKey &&
        typeof data[pathKey] === "string" &&
        data[pathKey].trim() !== ""
      ) {
        const fromPath = extractPathArgsFromDoc(data, {
          pathKey,
          documentKey,
          parentKeys,
          documentPathTemplate,
          isGroup: true,
        });
        if (fromPath && fromPath.length > 1) {
          parentArgs = fromPath.slice(0, -1);
        }
      }

      if (parentArgs.length === 0) {
        throw new Error(
          "Cannot use create() on collection groups without parent keys. Configure a path template (e.g. 'residences/{residenceId}/events') or provide parent keys in data.",
        );
      }

      docId = hasProvidedDocId ? data[documentKey] : generateFirestoreId();
      docRef = documentRef(...parentArgs, docId);
      enrichedData[documentKey] = docRef?.id ?? docId;
      if (pathKey && docRef?.path) {
        enrichedData[pathKey] = docRef.path;
      }
      await docRef.set(enrichedData);
    }

    if (typeof docRef?.get === "function") {
      const createdDoc = await docRef.get();
      const rawData =
        typeof createdDoc?.data === "function"
          ? createdDoc.data()
          : enrichedData;
      return maybeNormalize(rawData ?? enrichedData) as T;
    }

    return maybeNormalize(enrichedData) as T;
  };

  // Set - creates or replaces a document
  const set = async (...args: any[]): Promise<T> => {
    const lastArg = args[args.length - 1];
    const hasOptions =
      typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

    const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
    const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
    const mergeOption = hasOptions ? lastArg : { merge: true };

    const enrichedData = { ...data };

    // Auto-set createdKey if not already provided in data
    if (createdKey && enrichedData[createdKey] === undefined) {
      enrichedData[createdKey] = now();
    }

    // Auto-set updatedKey
    if (updatedKey) {
      enrichedData[updatedKey] = now();
    }

    const docRef = documentRef(...pathArgs);

    // Inject documentKey (last segment of the path args) and pathKey — same
    // behaviour as create() and batch.set() so the fields are always present.
    const docIdValue = pathArgs[pathArgs.length - 1];
    if (documentKey && docIdValue != null) {
      enrichedData[documentKey] = docIdValue;
    }
    if (pathKey) {
      enrichedData[pathKey] = docRef.path;
    }

    await docRef.set(enrichedData, mergeOption);

    if (typeof docRef?.get === "function") {
      const setDocument = await docRef.get();
      const rawData =
        typeof setDocument?.data === "function"
          ? setDocument.data()
          : enrichedData;
      return maybeNormalize(rawData ?? enrichedData) as T;
    }

    return maybeNormalize(enrichedData) as T;
  };

  // Update - updates a document and returns the merged object
  const update = async (...args: any[]): Promise<T> => {
    const data = args.pop();
    const pathArgs = args;

    // Auto-set updatedKey
    const enrichedData = { ...data };
    if (updatedKey) {
      enrichedData[updatedKey] = now();
    }

    const docRef = documentRef(...pathArgs);
    await docRef.update(enrichedData);

    const updatedDoc = await docRef.get();
    return maybeNormalize(updatedDoc.data()) as T;
  };

  // Delete - removes a document
  const deleteMethod = async (...args: any[]): Promise<void> => {
    const docRef = documentRef(...args);
    await docRef.delete();
  };

  return {
    create,
    set,
    update,
    delete: deleteMethod,
  };
}
