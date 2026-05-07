/**
 * Pure unit tests for v1 ↔ v2 history doc normalisation.
 */
import { describe, expect, test } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import { normalizeHistoryDocs } from "../../src/history/normalize";
import type { V1HistoryDoc, V2HistoryDoc } from "../../src/history/types";

const ts = (ms: number) => Timestamp.fromMillis(ms);

describe("normalizeHistoryDocs", () => {
  test("v2 docs pass through unchanged", () => {
    const doc: V2HistoryDoc = {
      schemaVersion: 2,
      historyDocId: "h1",
      historyToObjectId: "obj1",
      historySetAt: ts(1000),
      operation: "update",
      meta: { userId: "u1" },
      changes: {
        name: {
          oldValue: "A",
          newValue: "B",
          type: { old: "string", new: "string" },
        },
      },
    };
    const out = normalizeHistoryDocs([doc as any]);
    expect(out).toHaveLength(1);
    expect(out[0].schemaVersion).toBe(2);
    expect(out[0].changes.name.newValue).toBe("B");
    expect(out[0].meta.userId).toBe("u1");
  });

  test("v1 single doc → unified entry with one field", () => {
    const v1: V1HistoryDoc = {
      historyDocId: "h1",
      historyToObjectId: "obj1",
      historyUserId: "u1",
      historyUserEmail: "u1@x",
      historySetAt: ts(2000),
      field: "name",
      changes: { oldValue: "A", newValue: "B" },
      types: { oldValue: "string", newValue: "string" },
    };
    const out = normalizeHistoryDocs([v1 as any]);
    expect(out).toHaveLength(1);
    expect(out[0].schemaVersion).toBe(1);
    expect(out[0].operation).toBe("update");
    expect(out[0].meta.userId).toBe("u1");
    expect(out[0].meta.userEmail).toBe("u1@x");
    expect(Object.keys(out[0].changes)).toEqual(["name"]);
    expect(out[0].changes.name).toEqual({
      oldValue: "A",
      newValue: "B",
      type: { old: "string", new: "string" },
    });
  });

  test("consecutive v1 docs with same timestamp + author merge", () => {
    const base = {
      historyToObjectId: "obj1",
      historyUserId: "u1",
      historySetAt: ts(3000),
      types: { oldValue: "string", newValue: "string" },
    };
    const docs: V1HistoryDoc[] = [
      {
        ...base,
        historyDocId: "h1",
        field: "name",
        changes: { oldValue: "A", newValue: "B" },
      },
      {
        ...base,
        historyDocId: "h2",
        historySetAt: ts(3002), // within tolerance
        field: "city",
        changes: { oldValue: "P", newValue: "L" },
      },
    ];
    const out = normalizeHistoryDocs(docs as any);
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0].changes).sort()).toEqual(["city", "name"]);
  });

  test("v1 docs with different authors do NOT merge", () => {
    const docs: V1HistoryDoc[] = [
      {
        historyDocId: "h1",
        historyToObjectId: "obj1",
        historyUserId: "u1",
        historySetAt: ts(4000),
        field: "name",
        changes: { oldValue: "A", newValue: "B" },
      },
      {
        historyDocId: "h2",
        historyToObjectId: "obj1",
        historyUserId: "u2",
        historySetAt: ts(4000),
        field: "city",
        changes: { oldValue: "P", newValue: "L" },
      },
    ];
    const out = normalizeHistoryDocs(docs as any);
    expect(out).toHaveLength(2);
  });

  test("mixed v1 + v2 docs are normalised independently", () => {
    const v1: V1HistoryDoc = {
      historyDocId: "h1",
      historyToObjectId: "obj1",
      historyUserId: "u1",
      historySetAt: ts(5000),
      field: "name",
      changes: { oldValue: "A", newValue: "B" },
    };
    const v2: V2HistoryDoc = {
      schemaVersion: 2,
      historyDocId: "h2",
      historyToObjectId: "obj1",
      historySetAt: ts(6000),
      operation: "update",
      meta: { userId: "u2" },
      changes: {
        city: {
          oldValue: "P",
          newValue: "L",
          type: { old: "string", new: "string" },
        },
      },
    };
    const out = normalizeHistoryDocs([v1, v2] as any);
    expect(out).toHaveLength(2);
    expect(out[0].schemaVersion).toBe(1);
    expect(out[1].schemaVersion).toBe(2);
  });

  test("v1 extraHistoryDetails maps to meta.reason / comment", () => {
    const v1: V1HistoryDoc = {
      historyDocId: "h1",
      historyToObjectId: "obj1",
      historyUserId: "u1",
      historySetAt: ts(7000),
      field: "name",
      changes: { oldValue: "A", newValue: "B" },
      extraHistoryDetails: {
        reason: "fix typo",
        comment: "back-office",
        toKey: "name",
        force: false,
      },
    };
    const out = normalizeHistoryDocs([v1 as any]);
    expect(out[0].meta.reason).toBe("fix typo");
    expect(out[0].meta.comment).toBe("back-office");
  });
});
