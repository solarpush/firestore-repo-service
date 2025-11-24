import type { CollectionReference } from "firebase-admin/firestore";

/**
 * Creates CRUD methods (create, set, update, delete)
 */
export function createCrudMethods(
  actualCollection: CollectionReference | null,
  documentRef: (...args: any[]) => any
) {
  // Create - adds a new document with auto-generated ID
  const create = async (data: any): Promise<any> => {
    if (!actualCollection) {
      throw new Error(
        "Cannot use create() on collection groups. Use set() with a specific document ID instead."
      );
    }
    const docRef = await actualCollection.add(data);
    const createdDoc = await docRef.get();
    return { ...createdDoc.data(), docId: docRef.id };
  };

  // Set - creates or replaces a document
  const set = async (...args: any[]): Promise<any> => {
    const lastArg = args[args.length - 1];
    const hasOptions =
      typeof lastArg === "object" && lastArg !== null && "merge" in lastArg;

    const data = hasOptions ? args[args.length - 2] : args[args.length - 1];
    const pathArgs = hasOptions ? args.slice(0, -2) : args.slice(0, -1);
    const mergeOption = hasOptions ? lastArg : { merge: true };

    const docRef = documentRef(...pathArgs);
    await docRef.set(data, mergeOption);

    const setDocument = await docRef.get();
    return { ...setDocument.data(), docId: docRef.id };
  };

  // Update - updates a document and returns the merged object
  const update = async (...args: any[]): Promise<any> => {
    const data = args.pop();
    const pathArgs = args;

    const docRef = documentRef(...pathArgs);
    await docRef.update(data);

    const updatedDoc = await docRef.get();
    return { ...updatedDoc.data(), docId: docRef.id };
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
