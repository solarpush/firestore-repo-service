import type { CollectionReference } from "firebase-admin/firestore";

/**
 * Creates CRUD methods (create, set, update, delete)
 */
export function createCrudMethods<T>(
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => any,
  documentKey: string,
  pathKey?: string,
  createdKey?: string,
  updatedKey?: string
) {
  const now = () => new Date();

  // Create - adds a new document, optionally with a provided document key
  const create = async (data: any): Promise<T> => {
    if (!actualCollection) {
      throw new Error(
        "Cannot use create() on collection groups. Use set() with a specific document ID instead."
      );
    }

    let docRef;
    let docId: string;

    // Auto-set createdKey and updatedKey
    const enrichedData = { ...data };
    if (createdKey) {
      enrichedData[createdKey] = now();
    }
    if (updatedKey) {
      enrichedData[updatedKey] = now();
    }

    // If documentKey is provided in data, use set() with that ID
    if (data[documentKey]) {
      docId = data[documentKey];
      docRef = actualCollection.doc(docId);
      // Also set pathKey if defined
      const dataWithPath = pathKey
        ? { ...enrichedData, [pathKey]: docRef.path }
        : enrichedData;
      await docRef.set(dataWithPath);
    } else {
      // Otherwise, use add() to auto-generate ID
      docRef = await actualCollection.add(enrichedData);
      docId = docRef.id;
      // Update the document to include the documentKey and optionally pathKey
      const updates: Record<string, string> = { [documentKey]: docId };
      if (pathKey) {
        updates[pathKey] = docRef.path;
      }
      await docRef.update(updates);
    }

    const createdDoc = await docRef.get();
    return createdDoc.data() as T;
  };

  // Set - creates or replaces a document
  const set = async (...args: any[]): Promise<T> => {
    const lastArg = args[args.length - 1];
    const hasOptions =
      typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

    const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
    const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
    const mergeOption = hasOptions ? lastArg : { merge: true };

    // Auto-set updatedKey
    const enrichedData = { ...data };
    if (updatedKey) {
      enrichedData[updatedKey] = now();
    }

    const docRef = documentRef(...pathArgs);
    await docRef.set(enrichedData, mergeOption);

    const setDocument = await docRef.get();
    return setDocument.data() as T;
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
    return updatedDoc.data() as T;
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
