import { describe, expect, test } from "bun:test";
import { createGetMethods } from "../../src/methods/get";

describe("createGetMethods with isGroup / subcollections", () => {
  test("uses direct documentRef when parent path args are provided (args.length > 1)", async () => {
    let documentRefCalledWith: any[] = [];
    let collectionRefWhereCalledWith: any[] = [];

    const mockDocumentRef = (...args: any[]) => {
      documentRefCalledWith = args;
      return {
        get: async () => ({
          exists: true,
          data: () => ({ id: "c1", content: "hello", documentPath: "posts/p1/comments/c1" }),
        }),
      } as any;
    };

    const mockCollectionRef = {
      where: (...whereArgs: any[]) => {
        collectionRefWhereCalledWith = whereArgs;
        return {
          limit: () => ({
            select: () => ({
              get: async () => ({ empty: true, docs: [] }),
            }),
            get: async () => ({ empty: true, docs: [] }),
          }),
        };
      },
    } as any;

    const getMethods = createGetMethods(
      mockCollectionRef,
      ["docId", "postId"],
      null, // actualCollection is null for isGroup: true repos
      mockDocumentRef,
      "docId",
    );

    // Call byDocId with parent ID + document ID
    const result = await getMethods.byDocId("p1", "c1");

    expect(documentRefCalledWith).toEqual(["p1", "c1"]);
    expect(collectionRefWhereCalledWith).toEqual([]);
    expect(result).toEqual({ id: "c1", content: "hello", documentPath: "posts/p1/comments/c1" });
  });

  test("falls back to collectionGroup query when only docId is provided for isGroup: true (actualCollection === null)", async () => {
    let documentRefCalledWith: any[] = [];
    let collectionRefWhereCalledWith: any[] = [];

    const mockDocumentRef = (...args: any[]) => {
      documentRefCalledWith = args;
      return {
        get: async () => ({
          exists: false,
          data: () => null,
        }),
      } as any;
    };

    const mockCollectionRef = {
      where: (...whereArgs: any[]) => {
        collectionRefWhereCalledWith = whereArgs;
        return {
          limit: () => ({
            select: () => ({
              get: async () => ({ empty: true, docs: [] }),
            }),
            get: async () => ({
              empty: false,
              docs: [
                {
                  data: () => ({ id: "c1", content: "hello from group" }),
                },
              ],
            }),
          }),
        };
      },
    } as any;

    const getMethods = createGetMethods(
      mockCollectionRef,
      ["docId", "postId"],
      null, // actualCollection is null for isGroup: true repos
      mockDocumentRef,
      "docId",
    );

    // Call byDocId with ONLY document ID
    const result = await getMethods.byDocId("c1");

    // documentRef should NOT be called when only 1 arg is provided and actualCollection is null
    expect(documentRefCalledWith).toEqual([]);
    expect(collectionRefWhereCalledWith).toEqual(["docId", "==", "c1"]);
    expect(result).toEqual({ id: "c1", content: "hello from group" });
  });

  test("uses direct documentRef for regular collection (actualCollection !== null) with single docId", async () => {
    let documentRefCalledWith: any[] = [];

    const mockDocumentRef = (...args: any[]) => {
      documentRefCalledWith = args;
      return {
        get: async () => ({
          exists: true,
          data: () => ({ id: "u1", name: "Alice" }),
        }),
      } as any;
    };

    const mockActualCollection = {} as any;
    const mockCollectionRef = {} as any;

    const getMethods = createGetMethods(
      mockCollectionRef,
      ["docId", "email"],
      mockActualCollection,
      mockDocumentRef,
      "docId",
    );

    const result = await getMethods.byDocId("u1");

    expect(documentRefCalledWith).toEqual(["u1"]);
    expect(result).toEqual({ id: "u1", name: "Alice" });
  });
});
