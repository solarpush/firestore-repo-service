/**
 * Regression tests for the security & robustness audit fixes:
 *  #01 SyncQueue drains the full buffer (no data loss under burst)
 *  #08 BigQuery identifier escaping (DDL injection)
 *  #11 flattenObject cycle / depth guards
 *  #15 timestamp coercion conditioned on the destination column type
 */

import { describe, test, expect } from "bun:test";
import { SyncQueue } from "../../src/sync/queue";
import { serializeDocument } from "../../src/sync/serializer";
import { bigqueryDialect, BigQueryAdapter } from "../../src/sync/adapters/bigquery";
import { createSyncWorker } from "../../src/sync/worker";
import { z } from "zod";
import type { SqlAdapter, SyncEvent } from "../../src/sync/types";

// ---------------------------------------------------------------------------
// #01 — SyncQueue drains the whole buffer, not just one batch
// ---------------------------------------------------------------------------

describe("#01 SyncQueue.flush drains the entire buffer", () => {
  function makeAdapter(): { adapter: SqlAdapter; upserted: () => number } {
    let upserted = 0;
    const adapter = {
      dialect: bigqueryDialect,
      async tableExists() {
        return true;
      },
      async getTableColumns() {
        return [];
      },
      async createTable() {},
      async addColumns() {},
      async upsertRows(_t: string, rows: Record<string, unknown>[]) {
        upserted += rows.length;
      },
      async deleteRows() {},
    } as unknown as SqlAdapter;
    return { adapter, upserted: () => upserted };
  }

  test("a single flush() persists more than batchSize events", async () => {
    const { adapter, upserted } = makeAdapter();
    const q = new SyncQueue({
      adapter,
      tableName: "t",
      primaryKey: "id",
      batchSize: 100,
      flushIntervalMs: 0,
    });

    for (let i = 0; i < 1000; i++) {
      q.enqueue({
        operation: "CREATE",
        repoName: "r",
        docId: `d${i}`,
        data: { id: `d${i}`, __sync_version: i },
        timestamp: new Date().toISOString(),
      } as SyncEvent);
    }

    await q.flush();
    expect(q.size).toBe(0);
    expect(upserted()).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// #08 — identifier escaping
// ---------------------------------------------------------------------------

describe("#08 BigQuery quoteIdentifier escapes backticks", () => {
  test("plain identifier", () => {
    expect(bigqueryDialect.quoteIdentifier("ok")).toBe("`ok`");
  });

  test("embedded backtick is doubled (no injection break-out)", () => {
    expect(bigqueryDialect.quoteIdentifier("a`b")).toBe("`a``b`");
    expect(bigqueryDialect.quoteIdentifier("`; DROP TABLE x; --")).toBe(
      "```; DROP TABLE x; --`",
    );
  });
});

// ---------------------------------------------------------------------------
// #11 — flattenObject cycle / depth guards
// ---------------------------------------------------------------------------

describe("#11 serializeDocument guards against cycles & deep nesting", () => {
  test("self-referential object does not overflow the stack", () => {
    const doc: any = { name: "x" };
    doc.self = doc;
    let out: Record<string, unknown> = {};
    expect(() => {
      out = serializeDocument(doc);
    }).not.toThrow();
    expect(out["name"]).toBe("x");
  });

  test("excessively deep nesting is truncated, not fatal", () => {
    const root: any = {};
    let cur = root;
    for (let i = 0; i < 5000; i++) {
      cur.child = {};
      cur = cur.child;
    }
    expect(() => serializeDocument(root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #15 — timestamp coercion only on TIMESTAMP columns
// ---------------------------------------------------------------------------

describe("#15 ISO coercion is conditioned on the destination column type", () => {
  test("a STRING column keeps an ISO-looking value as a string", async () => {
    let capturedRows: Record<string, unknown>[] = [];
    const fakeWriter = {
      appendRows: (rows: Record<string, unknown>[]) => {
        capturedRows = rows;
        return { getResult: async () => undefined };
      },
      close: () => {},
    };
    const fakeBigquery: any = {
      dataset: () => ({
        table: () => ({
          getMetadata: async () => [
            {
              schema: {
                fields: [
                  { name: "post_id", type: "STRING" },
                  { name: "slug", type: "STRING" },
                  { name: "createdAt", type: "TIMESTAMP" },
                ],
              },
              tableConstraints: { primaryKey: { columns: ["post_id"] } },
            },
          ],
        }),
      }),
      query: async () => {},
    };

    const adapter: any = new BigQueryAdapter({
      bigquery: fakeBigquery,
      datasetId: "ds",
      projectId: "proj",
      writerClient: {
        createStreamConnection: async () => ({}),
        close: () => {},
      },
    });

    // Inject the writer cache entry directly, mirroring what
    // getOrCreateWriter computes from table metadata (createdAt is the only
    // TIMESTAMP column).
    (adapter as any).writers.set("posts", {
      writer: fakeWriter,
      primaryKey: "post_id",
      timestampColumns: new Set(["createdAt"]),
    });

    await adapter.upsertRows(
      "posts",
      [
        {
          post_id: "p1",
          slug: "2026-03-29T10:00:00Z-launch",
          createdAt: "2026-03-29T20:59:27.394Z",
        },
      ],
      "post_id",
    );

    const row = capturedRows[0]!;
    // STRING column → untouched
    expect(row["slug"]).toBe("2026-03-29T10:00:00Z-launch");
    // TIMESTAMP column → epoch micros (digits, no hyphen)
    expect(typeof row["createdAt"]).toBe("string");
    expect(row["createdAt"]).not.toContain("-");
  });
});

// ---------------------------------------------------------------------------
// #09 — DLQ retry cap + idempotent topic create
// ---------------------------------------------------------------------------

describe("#09 DLQ retry cap and idempotent create", () => {
  const repo = { schema: z.object({ docId: z.string() }), _systemKeys: ["docId"], ref: { path: "users" } };
  const failingAdapter = {
    dialect: bigqueryDialect,
    async tableExists() { return true; },
    async getTableColumns() { return []; },
    async createTable() {},
    async addColumns() {},
    async upsertRows() { throw new Error("flush boom"); },
    async deleteRows() {},
  } as unknown as SqlAdapter;

  function makeWorker(topicImpl: any, maxDlqAttempts?: number) {
    return createSyncWorker(
      { users: repo },
      {
        deps: {
          pubsubHandler: { onMessagePublished: () => {} } as any,
          pubsub: { topic: () => topicImpl } as any,
        },
        adapter: failingAdapter,
        batchSize: 100,
        flushIntervalMs: 0,
        autoMigrate: false,
        ...(maxDlqAttempts !== undefined ? { maxDlqAttempts } : {}),
      },
    );
  }

  test("first failure republishes with attempts=1 and firstFailedAt", async () => {
    const published: any[] = [];
    const topic = {
      publishMessage: async (m: any) => { published.push(m.json); },
      create: async () => {},
    };
    const worker = makeWorker(topic);
    await worker.handleMessage({ operation: "UPSERT", repoName: "users", docId: "u1", data: { docId: "u1" }, timestamp: new Date().toISOString() } as SyncEvent);
    await worker.queues.get("users")!.flush();
    expect(published).toHaveLength(1);
    expect(published[0].attempts).toBe(1);
    expect(typeof published[0].firstFailedAt).toBe("number");
  });

  test("poison event past maxDlqAttempts is dropped", async () => {
    const published: any[] = [];
    const topic = {
      publishMessage: async (m: any) => { published.push(m.json); },
      create: async () => {},
    };
    const worker = makeWorker(topic, 5);
    await worker.handleMessage({ operation: "UPSERT", repoName: "users", docId: "u1", data: { docId: "u1" }, timestamp: new Date().toISOString(), attempts: 5 } as SyncEvent);
    await worker.queues.get("users")!.flush();
    expect(published).toHaveLength(0);
  });

  test("create() ALREADY_EXISTS (code 6) is swallowed", async () => {
    const published: any[] = [];
    const topic = {
      publishMessage: async (m: any) => { published.push(m.json); },
      create: async () => { const e: any = new Error("exists"); e.code = 6; throw e; },
    };
    const worker = makeWorker(topic);
    await worker.handleMessage({ operation: "UPSERT", repoName: "users", docId: "u1", data: { docId: "u1" }, timestamp: new Date().toISOString() } as SyncEvent);
    await expect(worker.queues.get("users")!.flush()).resolves.toBeUndefined();
    expect(published).toHaveLength(1);
  });
});
