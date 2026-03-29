/**
 * Tests for the Firestore → BigQuery sync pipeline, focusing on
 * columnMap handling through serializer, worker (handleMessage), and queue.
 */

import { describe, test, expect, mock } from "bun:test";
import { z } from "zod";
import { serializeDocument } from "../../src/sync/serializer";
import { zodSchemaToColumns } from "../../src/sync/schema-mapper";
import { createSyncWorker } from "../../src/sync/worker";
import type { SqlAdapter, SqlColumn, SqlDialect, SqlTableDef } from "../../src/sync/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDialect: SqlDialect = {
  name: "test",
  mapType(logical) {
    return logical.toUpperCase();
  },
  quoteIdentifier(id) {
    return `"${id}"`;
  },
};

function createMockAdapter(): SqlAdapter & {
  upsertCalls: Array<{ tableName: string; rows: Record<string, unknown>[]; primaryKey: string }>;
  deleteCalls: Array<{ tableName: string; primaryKey: string; ids: string[] }>;
} {
  const adapter: any = {
    dialect: testDialect,
    upsertCalls: [],
    deleteCalls: [],
    tableExists: mock(async () => false),
    getTableColumns: mock(async () => []),
    createTable: mock(async () => {}),
    addColumns: mock(async () => {}),
    insertRows: mock(async () => {}),
    executeRaw: mock(async () => {}),
    upsertRows: mock(async (tableName: string, rows: Record<string, unknown>[], primaryKey: string) => {
      adapter.upsertCalls.push({ tableName, rows, primaryKey });
    }),
    deleteRows: mock(async (tableName: string, primaryKey: string, ids: string[]) => {
      adapter.deleteCalls.push({ tableName, primaryKey, ids });
    }),
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// serializeDocument — columnMap
// ---------------------------------------------------------------------------

describe("serializeDocument", () => {
  test("renames top-level fields via columnMap", () => {
    const doc = { docId: "u1", email: "a@b.com", name: "Alice" };
    const result = serializeDocument(doc, {
      columnMap: { docId: "user_id" },
    });
    expect(result).toEqual({ user_id: "u1", email: "a@b.com", name: "Alice" });
    expect(result).not.toHaveProperty("docId");
  });

  test("excludes fields", () => {
    const doc = { docId: "u1", password: "secret", name: "Alice" };
    const result = serializeDocument(doc, {
      exclude: ["password"],
    });
    expect(result).toEqual({ docId: "u1", name: "Alice" });
  });

  test("applies columnMap to nested (flattened) fields via bare field name", () => {
    const doc = { id: "1", address: { street: "123 Main", city: "NYC" } };
    const result = serializeDocument(doc, {
      columnMap: { street: "addr_street" } as any,
    });
    // Nested field "address__street" should match bare "street" in columnMap
    expect(result).toHaveProperty("addr_street", "123 Main");
    expect(result).not.toHaveProperty("address__street");
    // "city" has no mapping → stays as "address__city"
    expect(result).toHaveProperty("address__city", "NYC");
  });

  test("full flattened key takes priority over bare field name in columnMap", () => {
    const doc = { id: "1", address: { street: "123 Main" } };
    const result = serializeDocument(doc, {
      columnMap: {
        "address__street": "full_key_name",
        street: "bare_name",
      } as any,
    });
    expect(result).toHaveProperty("full_key_name", "123 Main");
  });
});

// ---------------------------------------------------------------------------
// zodSchemaToColumns — columnMap consistency with serializer
// ---------------------------------------------------------------------------

describe("zodSchemaToColumns with columnMap", () => {
  const schema = z.object({
    docId: z.string(),
    email: z.string(),
    address: z.object({
      street: z.string(),
      city: z.string(),
    }),
  });

  test("maps top-level primary key via columnMap", () => {
    const cols = zodSchemaToColumns(schema, testDialect, {
      primaryKey: "docId",
      columnMap: { docId: "user_id" },
    });
    const pkCol = cols.find((c) => c.isPrimaryKey);
    expect(pkCol).toBeDefined();
    expect(pkCol!.name).toBe("user_id");
  });

  test("column names match serializeDocument output", () => {
    const columnMap = { docId: "user_id" };
    const cols = zodSchemaToColumns(schema, testDialect, {
      primaryKey: "docId",
      columnMap,
    });
    const colNames = new Set(cols.map((c) => c.name));

    const doc = { docId: "u1", email: "a@b.com", address: { street: "Main", city: "NYC" } };
    const serialized = serializeDocument(doc, { columnMap });
    const dataKeys = new Set(Object.keys(serialized));

    // Every key in serialized data should have a matching column
    for (const key of dataKeys) {
      expect(colNames.has(key)).toBe(true);
    }
  });

  test("nested field bare-name columnMap is consistent between schema and serializer", () => {
    const columnMap = { street: "addr_street" } as Record<string, string>;
    const cols = zodSchemaToColumns(schema, testDialect, {
      primaryKey: "docId",
      columnMap,
    });
    const colNames = new Set(cols.map((c) => c.name));

    const doc = { docId: "u1", email: "a@b.com", address: { street: "Main", city: "NYC" } };
    const serialized = serializeDocument(doc, { columnMap });
    const dataKeys = new Set(Object.keys(serialized));

    // Both should produce "addr_street", not "address__street"
    expect(colNames.has("addr_street")).toBe(true);
    expect(dataKeys.has("addr_street")).toBe(true);
    expect(colNames.has("address__street")).toBe(false);
    expect(dataKeys.has("address__street")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleMessage — end-to-end with columnMap
// ---------------------------------------------------------------------------

describe("handleMessage with columnMap", () => {
  const userSchema = z.object({
    docId: z.string(),
    email: z.string(),
    name: z.string(),
  });

  function createFakeRepo() {
    return {
      schema: userSchema,
      _systemKeys: ["docId", "documentPath"],
      _isGroup: false,
      ref: { path: "users" },
    };
  }

  test("upserts use mapped primaryKey and mapped data keys", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 100,
        flushIntervalMs: 0, // disable timer
        autoMigrate: false,
        repos: {
          users: { columnMap: { docId: "user_id" } },
        },
      },
    );

    await worker.handleMessage({
      operation: "UPSERT",
      repoName: "users",
      docId: "u1",
      data: { user_id: "u1", email: "a@b.com", name: "Alice" },
      timestamp: new Date().toISOString(),
    });

    // handleMessage enqueues but doesn't flush — caller must flush
    const q = worker.queues.get("users");
    expect(q).toBeDefined();
    await q!.flush();

    expect(adapter.upsertCalls.length).toBe(1);
    const call = adapter.upsertCalls[0]!;
    expect(call.primaryKey).toBe("user_id");
    expect(call.rows[0]).toHaveProperty("user_id", "u1");
    expect(call.rows[0]).not.toHaveProperty("docId");
  });

  test("deletes use mapped primaryKey", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 100,
        flushIntervalMs: 0,
        autoMigrate: false,
        repos: {
          users: { columnMap: { docId: "user_id" } },
        },
      },
    );

    await worker.handleMessage({
      operation: "DELETE",
      repoName: "users",
      docId: "u1",
      data: null,
      timestamp: new Date().toISOString(),
    });

    const q = worker.queues.get("users");
    expect(q).toBeDefined();
    await q!.flush();

    expect(adapter.deleteCalls.length).toBe(1);
    expect(adapter.deleteCalls[0]!.primaryKey).toBe("user_id");
    expect(adapter.deleteCalls[0]!.ids).toEqual(["u1"]);
  });

  test("handleMessage enqueues without flushing (caller flushes)", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 1000, // high batch size
        flushIntervalMs: 0,
        autoMigrate: false,
        repos: {},
      },
    );

    await worker.handleMessage({
      operation: "UPSERT",
      repoName: "users",
      docId: "u1",
      data: { docId: "u1", email: "a@b.com", name: "Alice" },
      timestamp: new Date().toISOString(),
    });

    // handleMessage does NOT flush — data is buffered in the queue
    expect(adapter.upsertCalls.length).toBe(0);

    // Explicit flush writes the data
    const q = worker.queues.get("users");
    await q!.flush();
    expect(adapter.upsertCalls.length).toBe(1);

    await worker.shutdown();
  });

  test("without columnMap, primaryKey defaults to documentKey", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 100,
        flushIntervalMs: 0,
        autoMigrate: false,
        repos: {},
      },
    );

    await worker.handleMessage({
      operation: "UPSERT",
      repoName: "users",
      docId: "u1",
      data: { docId: "u1", email: "a@b.com", name: "Alice" },
      timestamp: new Date().toISOString(),
    });

    const q = worker.queues.get("users");
    await q!.flush();

    expect(adapter.upsertCalls.length).toBe(1);
    expect(adapter.upsertCalls[0]!.primaryKey).toBe("docId");
    await worker.shutdown();
  });

  test("autoMigrate creates table with mapped column names", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 100,
        flushIntervalMs: 0,
        autoMigrate: true,
        repos: {
          users: { columnMap: { docId: "user_id" } },
        },
      },
    );

    await worker.handleMessage({
      operation: "UPSERT",
      repoName: "users",
      docId: "u1",
      data: { user_id: "u1", email: "a@b.com", name: "Alice" },
      timestamp: new Date().toISOString(),
    });

    // createTable should have been called with mapped column names
    expect(adapter.createTable).toHaveBeenCalled();
    const createCall = (adapter.createTable as any).mock.calls[0] as [SqlTableDef];
    const colNames = createCall[0].columns.map((c: SqlColumn) => c.name);
    expect(colNames).toContain("user_id");
    expect(colNames).not.toContain("docId");

    await worker.shutdown();
  });

  test("createHandler flushes after handleMessage (PubSub Cloud Function safety)", async () => {
    const adapter = createMockAdapter();
    const repo = createFakeRepo();

    let registeredCallback: ((event: any) => Promise<void>) | null = null;
    const fakePubsubHandler = {
      onMessagePublished: (_topic: string, cb: (event: any) => Promise<void>) => {
        registeredCallback = cb;
        return "cloud-function-stub";
      },
    };

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: fakePubsubHandler as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, exists: async () => [false], create: async () => {} }) } as any,
        },
        adapter,
        batchSize: 1000, // high batch size to prove flush is explicit
        flushIntervalMs: 0,
        autoMigrate: false,
        repos: { users: { columnMap: { docId: "user_id" } } },
      },
    );

    // Create the handler to register the callback
    worker.createHandler("firestore-sync-users");
    expect(registeredCallback).not.toBeNull();

    // Simulate a PubSub event
    await registeredCallback!({
      data: {
        message: {
          json: {
            operation: "UPSERT",
            repoName: "users",
            docId: "u1",
            data: { user_id: "u1", email: "a@b.com", name: "Alice" },
            timestamp: new Date().toISOString(),
          },
        },
      },
    });

    // createHandler should have flushed after handleMessage
    expect(adapter.upsertCalls.length).toBe(1);
    expect(adapter.upsertCalls[0]!.primaryKey).toBe("user_id");

    await worker.shutdown();
  });
});
