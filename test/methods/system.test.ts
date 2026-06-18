/**
 * Tests for `system.backfillKeys` — fills auto-managed system fields
 * (documentKey, pathKey, createdKey, updatedKey) on legacy documents,
 * idempotently and writing only the documents that need it.
 */

import { describe, expect, test } from "bun:test";
import { createSystemMethods } from "../../src/methods/system";

interface FakeDoc {
  id: string;
  ref: { path: string };
  data: () => Record<string, unknown>;
}

function makeDoc(
  id: string,
  path: string,
  data: Record<string, unknown>,
): FakeDoc {
  return { id, ref: { path }, data: () => ({ ...data }) };
}

/** Minimal Query stub supporting orderBy().startAfter().limit().get(). */
function makeCollection(docs: FakeDoc[]): any {
  const queryAt = (offset: number): any => ({
    orderBy: () => queryAt(offset),
    startAfter: (cursor: FakeDoc) => {
      const idx = docs.findIndex((d) => d.id === cursor.id);
      return queryAt(idx + 1);
    },
    limit: (n: number) => ({
      get: async () => {
        const page = docs.slice(offset, offset + n);
        return { empty: page.length === 0, size: page.length, docs: page };
      },
    }),
  });
  return queryAt(0);
}

interface CapturedWrite {
  path: string;
  data: Record<string, unknown>;
  opts: unknown;
}

function makeDb(writes: CapturedWrite[]): any {
  return {
    bulkWriter: () => ({
      onWriteError: () => {},
      onWriteResult: () => {},
      set: (ref: { path: string }, data: Record<string, unknown>, opts: unknown) => {
        writes.push({ path: ref.path, data, opts });
      },
      close: async () => {},
    }),
  };
}

const KEYS = ["docId", "documentPath", "createdAt", "updatedAt"] as const;

describe("system.backfillKeys", () => {
  test("fills missing keys, preserves existing createdAt, skips complete docs", async () => {
    const created = new Date("2020-01-01T00:00:00Z");
    const docs = [
      makeDoc("a", "col/a", {}),
      makeDoc("b", "col/b", {
        docId: "b",
        documentPath: "col/b",
        createdAt: created,
        updatedAt: created,
      }),
      makeDoc("c", "col/c", { createdAt: created }),
    ];
    const writes: CapturedWrite[] = [];
    const system = createSystemMethods(makeDb(writes), makeCollection(docs), ...KEYS);

    const result = await system.backfillKeys();

    expect(result.scanned).toBe(3);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);

    const byPath = Object.fromEntries(writes.map((w) => [w.path, w.data]));
    expect(Object.keys(byPath).sort()).toEqual(["col/a", "col/c"]);

    // Doc A — every managed field filled.
    expect(byPath["col/a"]).toMatchObject({ docId: "a", documentPath: "col/a" });
    expect(byPath["col/a"].createdAt).toBeInstanceOf(Date);
    expect(byPath["col/a"].updatedAt).toBeInstanceOf(Date);

    // Doc C — createdAt preserved (NOT in patch), the rest filled.
    expect(byPath["col/c"]).toMatchObject({ docId: "c", documentPath: "col/c" });
    expect(byPath["col/c"].updatedAt).toBeInstanceOf(Date);
    expect("createdAt" in byPath["col/c"]).toBe(false);

    // Writes are merges.
    for (const w of writes) expect(w.opts).toEqual({ merge: true });
  });

  test("dryRun counts what would change without writing", async () => {
    const docs = [makeDoc("a", "col/a", {}), makeDoc("b", "col/b", {})];
    const writes: CapturedWrite[] = [];
    const system = createSystemMethods(makeDb(writes), makeCollection(docs), ...KEYS);

    const result = await system.backfillKeys({ dryRun: true });

    expect(result.scanned).toBe(2);
    expect(result.written).toBe(2);
    expect(writes).toEqual([]);
  });

  test("overwriteCreated forces a new createdAt even when present", async () => {
    const created = new Date("2020-01-01T00:00:00Z");
    const docs = [
      makeDoc("a", "col/a", {
        docId: "a",
        documentPath: "col/a",
        createdAt: created,
        updatedAt: created,
      }),
    ];
    const writes: CapturedWrite[] = [];
    const system = createSystemMethods(makeDb(writes), makeCollection(docs), ...KEYS);

    const result = await system.backfillKeys({ overwriteCreated: true });

    expect(result.written).toBe(1);
    expect(writes[0]!.data.createdAt).toBeInstanceOf(Date);
    expect(writes[0]!.data.createdAt).not.toBe(created);
  });

  test("paginates across pages (pageSize smaller than collection)", async () => {
    const docs = [
      makeDoc("a", "col/a", {}),
      makeDoc("b", "col/b", {}),
      makeDoc("c", "col/c", {}),
    ];
    const writes: CapturedWrite[] = [];
    const system = createSystemMethods(makeDb(writes), makeCollection(docs), ...KEYS);

    const result = await system.backfillKeys({ pageSize: 1 });

    expect(result.scanned).toBe(3);
    expect(result.written).toBe(3);
    expect(writes.map((w) => w.path).sort()).toEqual(["col/a", "col/b", "col/c"]);
  });
});
