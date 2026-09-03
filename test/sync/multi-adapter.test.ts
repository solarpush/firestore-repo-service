import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { createFirestoreSync } from "../../src/sync/create-sync";
import type { SyncAdapter, SyncEvent } from "../../src/sync/types";
import { createSyncWorker } from "../../src/sync/worker";

function createMockSyncAdapter(name: string): SyncAdapter & {
  upsertCalls: Array<{ targetName: string; items: Record<string, unknown>[]; primaryKey: string }>;
  deleteCalls: Array<{ targetName: string; primaryKey: string; ids: string[] }>;
} {
  const adapter: any = {
    name,
    upsertCalls: [],
    deleteCalls: [],
    targetExists: mock(async () => true),
    ensureTarget: mock(async () => {}),
    healthCheck: mock(async ({ targetName }: any) => ({
      healthy: true,
      targetName,
      targetExists: true,
      error: null,
    })),
    upsert: mock(async (targetName: string, items: Record<string, unknown>[], primaryKey: string) => {
      adapter.upsertCalls.push({ targetName, items, primaryKey });
    }),
    delete: mock(async (targetName: string, primaryKey: string, ids: string[]) => {
      adapter.deleteCalls.push({ targetName, primaryKey, ids });
    }),
  };
  return adapter;
}

describe("Multi-Adapter Fan-out", () => {
  const userSchema = z.object({
    docId: z.string(),
    email: z.string(),
    name: z.string(),
  });

  const repo = {
    schema: userSchema,
    _systemKeys: ["docId"],
    _isGroup: false,
    ref: { path: "users" },
  };

  test("fans out SyncEvent to all configured adapters", async () => {
    const bqAdapter = createMockSyncAdapter("bigquery");
    const meiliAdapter = createMockSyncAdapter("meilisearch");

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, create: async () => {} }) } as any,
        },
        adapters: [bqAdapter, meiliAdapter],
        batchSize: 10,
        flushIntervalMs: 0,
      },
    );

    const event: SyncEvent = {
      operation: "INSERT",
      repoName: "users",
      docId: "u1",
      data: { docId: "u1", name: "Alice", email: "alice@example.com" },
      timestamp: new Date().toISOString(),
    };

    await worker.handleMessage(event);

    // Both queues are buffered
    expect(bqAdapter.upsertCalls.length).toBe(0);
    expect(meiliAdapter.upsertCalls.length).toBe(0);

    // Flush both queues
    const bqQueue = worker.queues.get("users:bigquery");
    const meiliQueue = worker.queues.get("users:meilisearch");

    expect(bqQueue).toBeDefined();
    expect(meiliQueue).toBeDefined();

    await bqQueue?.flush();
    await meiliQueue?.flush();

    expect(bqAdapter.upsertCalls.length).toBe(1);
    expect(bqAdapter.upsertCalls[0].items[0].name).toBe("Alice");

    expect(meiliAdapter.upsertCalls.length).toBe(1);
    expect(meiliAdapter.upsertCalls[0].items[0].name).toBe("Alice");
  });

  test("filters target adapters when repoSyncConfig.adapters is specified", async () => {
    const bqAdapter = createMockSyncAdapter("bigquery");
    const meiliAdapter = createMockSyncAdapter("meilisearch");

    const worker = createSyncWorker(
      {
        users: repo,
        logs: { ...repo, ref: { path: "logs" } },
      },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, create: async () => {} }) } as any,
        },
        adapters: [bqAdapter, meiliAdapter],
        batchSize: 10,
        flushIntervalMs: 0,
        repos: {
          logs: { adapters: ["bigquery"] }, // Only BigQuery for logs
        },
      },
    );

    await worker.handleMessage({
      operation: "INSERT",
      repoName: "logs",
      docId: "log1",
      data: { docId: "log1", message: "User logged in" },
      timestamp: new Date().toISOString(),
    });

    expect(worker.queues.get("logs:bigquery")).toBeDefined();
    expect(worker.queues.get("logs:meilisearch")).toBeUndefined();
  });

  test("isolates DLQ failure when one adapter fails", async () => {
    const bqAdapter = createMockSyncAdapter("bigquery");
    const meiliAdapter = createMockSyncAdapter("meilisearch");

    // Make meilisearch fail on upsert
    meiliAdapter.upsert = mock(async () => {
      throw new Error("Meilisearch server unavailable");
    });

    const dlqPublished: any[] = [];
    const mockPubsub = {
      topic: (name: string) => ({
        name,
        create: async () => {},
        publishMessage: async (payload: any) => {
          dlqPublished.push({ topic: name, payload });
        },
      }),
    };

    const worker = createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: mockPubsub as any,
        },
        adapters: [bqAdapter, meiliAdapter],
        batchSize: 10,
        flushIntervalMs: 0,
      },
    );

    await worker.handleMessage({
      operation: "INSERT",
      repoName: "users",
      docId: "u1",
      data: { docId: "u1", name: "Alice" },
      timestamp: new Date().toISOString(),
    });

    const bqQueue = worker.queues.get("users:bigquery");
    const meiliQueue = worker.queues.get("users:meilisearch");

    // BigQuery flush succeeds
    await bqQueue?.flush();
    expect(bqAdapter.upsertCalls.length).toBe(1);

    // Meilisearch flush fails and sends to its DLQ
    await meiliQueue?.flush();
    expect(dlqPublished.length).toBe(1);
    expect(dlqPublished[0].topic).toBe("firestore-sync-users-meilisearch-dlq");
    expect(dlqPublished[0].payload.json.docId).toBe("u1");
  });

  test("createFirestoreSync binds triggers, handlers, and admin with multiple adapters", async () => {
    const bqAdapter = createMockSyncAdapter("bigquery");
    const meiliAdapter = createMockSyncAdapter("meilisearch");

    const registeredTriggers: Record<string, any> = {};
    const mockFirestoreTriggers = {
      onDocumentWritten: (path: string, handler: any) => {
        registeredTriggers[path] = handler;
        return handler;
      },
    };

    const registeredPubSub: Record<string, any> = {};
    const mockPubSubHandler = {
      onMessagePublished: (topic: string, handler: any) => {
        registeredPubSub[topic] = handler;
        return handler;
      },
    };

    const sync = createFirestoreSync(
      { users: repo },
      {
        deps: {
          firestoreTriggers: mockFirestoreTriggers as any,
          pubsubHandler: mockPubSubHandler as any,
          pubsub: { topic: () => ({ publishMessage: async () => {}, create: async () => {} }) } as any,
        },
        adapters: [bqAdapter, meiliAdapter],
        admin: {
          auth: { type: "basic", username: "admin", password: "pwd" },
          featuresFlag: { healthCheck: true, manualSync: true },
        },
      },
    );

    // Exactly 1 trigger per repo: users_onSync
    expect(sync.functions.users_onSync).toBeDefined();
    expect(sync.functions.users_onCreate).toBeUndefined();
    expect(sync.functions.users_onUpdate).toBeUndefined();
    expect(sync.functions.users_onDelete).toBeUndefined();

    // PubSub worker function: sync_users
    expect(sync.functions.sync_users).toBeDefined();

    // Admin handler
    expect(sync.adminHandler).toBeDefined();
  });
});
