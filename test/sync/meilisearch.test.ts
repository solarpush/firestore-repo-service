import { describe, expect, mock, test } from "bun:test";
import { MeilisearchAdapter } from "../../src/sync/adapters/meilisearch";

describe("MeilisearchAdapter", () => {
  test("implements targetExists correctly", async () => {
    const mockClient = {
      getIndex: mock(async (uid: string) => {
        if (uid === "existing_index") return { uid };
        const err: any = new Error("Index not found");
        err.code = "index_not_found";
        throw err;
      }),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    expect(adapter.name).toBe("meilisearch");

    const exists = await adapter.targetExists("existing_index");
    expect(exists).toBe(true);

    const notExists = await adapter.targetExists("non_existing_index");
    expect(notExists).toBe(false);
  });

  test("upsert calls index.addDocuments with primaryKey", async () => {
    let capturedDocs: any[] = [];
    let capturedOptions: any = null;

    const mockIndex = {
      addDocuments: mock(async (docs: any[], opts?: any) => {
        capturedDocs = docs;
        capturedOptions = opts;
      }),
    };

    const mockClient = {
      index: mock((_uid: string) => mockIndex),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    const docs = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];

    await adapter.upsert("users", docs, "id");

    expect(capturedDocs).toEqual(docs);
    expect(capturedOptions).toEqual({ primaryKey: "id" });
  });

  test("upsert does nothing if items array is empty", async () => {
    const mockIndex = {
      addDocuments: mock(async () => {}),
    };
    const mockClient = {
      index: mock((_uid: string) => mockIndex),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    await adapter.upsert("users", [], "id");

    expect(mockIndex.addDocuments).not.toHaveBeenCalled();
  });

  test("delete calls index.deleteDocuments with IDs", async () => {
    let capturedIds: string[] = [];

    const mockIndex = {
      deleteDocuments: mock(async (ids: string[]) => {
        capturedIds = ids;
      }),
    };

    const mockClient = {
      index: mock((_uid: string) => mockIndex),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    await adapter.delete("users", "id", ["1", "2", "3"]);

    expect(capturedIds).toEqual(["1", "2", "3"]);
  });

  test("ensureTarget creates index and applies settings", async () => {
    let createdIndex: any = null;
    let updatedSettings: any = null;

    const mockIndex = {
      updateSettings: mock(async (settings: any) => {
        updatedSettings = settings;
      }),
    };

    const mockClient = {
      getIndex: mock(async (_uid: string) => {
        const err: any = new Error("Not found");
        err.code = "index_not_found";
        throw err;
      }),
      createIndex: mock(async (uid: string, opts?: any) => {
        createdIndex = { uid, opts };
      }),
      index: mock((_uid: string) => mockIndex),
    };

    const adapter = new MeilisearchAdapter({
      client: mockClient,
      indexesSettings: {
        users: {
          filterableAttributes: ["role", "status"],
          searchableAttributes: ["name", "email"],
        },
      },
    });

    await adapter.ensureTarget({
      targetName: "users",
      primaryKey: "user_id",
    });

    expect(createdIndex).toEqual({
      uid: "users",
      opts: { primaryKey: "user_id" },
    });
    expect(updatedSettings).toEqual({
      filterableAttributes: ["role", "status"],
      searchableAttributes: ["name", "email"],
    });
  });

  test("healthCheck returns healthy status and index statistics", async () => {
    const mockIndex = {
      getStats: mock(async () => ({
        numberOfDocuments: 42,
        isIndexing: false,
        fieldDistribution: { id: 42, name: 42 },
      })),
      getRawInfo: mock(async () => ({
        primaryKey: "user_id",
      })),
    };

    const mockClient = {
      getIndex: mock(async (_uid: string) => ({ uid: "users" })),
      index: mock((_uid: string) => mockIndex),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    const health = await adapter.healthCheck({
      targetName: "users",
      primaryKey: "user_id",
    });

    expect(health.healthy).toBe(true);
    expect(health.targetExists).toBe(true);
    expect(health.details).toEqual({
      numberOfDocuments: 42,
      isIndexing: false,
      fieldDistribution: { id: 42, name: 42 },
      primaryKey: "user_id",
    });
  });

  test("checkConnection verifies connectivity and returns version", async () => {
    const mockClient = {
      isHealthy: mock(async () => ({ status: "available" })),
      getVersion: mock(async () => ({ pkgVersion: "1.8.0" })),
    };

    const adapter = new MeilisearchAdapter({ client: mockClient });
    const res = await adapter.checkConnection();

    expect(res.healthy).toBe(true);
    expect(res.version).toBe("1.8.0");
  });
});
