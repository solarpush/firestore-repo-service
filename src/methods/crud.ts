import type {
  CollectionReference,
  DocumentReference,
} from "firebase-admin/firestore";

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
 * Creates CRUD methods (create, set, update, delete)
 */
export function createCrudMethods<T>(
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => any,
  autoFields?: { [K in keyof T]?: (docRef: DocumentReference) => T[K] }
) {
  // Create - adds a new document with auto-generated ID
  const create = async (data: any): Promise<T> => {
    if (!actualCollection) {
      throw new Error(
        "Cannot use create() on collection groups. Use set() with a specific document ID instead."
      );
    }
    const docRef = await actualCollection.add(data);
    const createdDoc = await docRef.get();
    return injectAutoFields<T>(createdDoc.data(), docRef, autoFields);
  };

  // Set - creates or replaces a document
  const set = async (...args: any[]): Promise<T> => {
    const lastArg = args[args.length - 1];
    const hasOptions =
      typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

    const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
    const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
    const mergeOption = hasOptions ? lastArg : { merge: true };

    const docRef = documentRef(...pathArgs);
    await docRef.set(data, mergeOption);

    const setDocument = await docRef.get();
    return injectAutoFields<T>(setDocument.data(), docRef, autoFields);
  };

  // Update - updates a document and returns the merged object
  const update = async (...args: any[]): Promise<T> => {
    const data = args.pop();
    const pathArgs = args;

    const docRef = documentRef(...pathArgs);
    await docRef.update(data);

    const updatedDoc = await docRef.get();
    return injectAutoFields<T>(updatedDoc.data(), docRef, autoFields);
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
