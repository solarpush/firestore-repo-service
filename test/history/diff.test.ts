/**
 * Pure unit tests for the history diff helper.
 */
import { describe, expect, test } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import { computeDiff, valueType, valuesEqual } from "../../src/history/diff";

describe("valueType", () => {
  test("returns expected primitive types", () => {
    expect(valueType(null)).toBe("null");
    expect(valueType(undefined)).toBe("undefined");
    expect(valueType("a")).toBe("string");
    expect(valueType(1)).toBe("number");
    expect(valueType(true)).toBe("boolean");
    expect(valueType([])).toBe("array");
    expect(valueType({})).toBe("object");
  });

  test("recognises Timestamp and Date", () => {
    expect(valueType(Timestamp.fromMillis(1))).toBe("timestamp");
    expect(valueType(new Date())).toBe("date");
  });
});

describe("valuesEqual", () => {
  test("primitives", () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual("a", "a")).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, undefined)).toBe(false);
    expect(valuesEqual(1, 2)).toBe(false);
  });

  test("arrays and objects", () => {
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("Timestamp equality", () => {
    const a = Timestamp.fromMillis(1234);
    const b = Timestamp.fromMillis(1234);
    expect(valuesEqual(a, b)).toBe(true);
    expect(valuesEqual(a, Timestamp.fromMillis(99))).toBe(false);
  });

  test("object comparison is key-order insensitive (#14)", () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valuesEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test("cycles do not throw and compare structurally (#14)", () => {
    const a: any = { name: "x" };
    a.self = a;
    const b: any = { name: "x" };
    b.self = b;
    expect(() => valuesEqual(a, b)).not.toThrow();
    expect(valuesEqual(a, b)).toBe(true);
  });

  test("array vs non-array are not equal", () => {
    expect(valuesEqual([1], { 0: 1 } as any)).toBe(false);
  });
});

describe("computeDiff", () => {
  test("detects added, changed and removed top-level fields", () => {
    const before = { a: 1, b: 2, c: 3 };
    const after = { a: 1, b: 99, d: 4 };
    const changes = computeDiff(before, after);
    expect(Object.keys(changes).sort()).toEqual(["b", "c", "d"]);
    expect(changes.b).toEqual({
      oldValue: 2,
      newValue: 99,
      type: { old: "number", new: "number" },
    });
    expect(changes.c.newValue).toBe(null);
    expect(changes.d.oldValue).toBe(null);
  });

  test("returns empty when nothing changed", () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toEqual({});
  });

  test("respects exclude + meta + system keys", () => {
    const changes = computeDiff(
      { a: 1, updatedBy: "u1", id: "x", created: 1 },
      { a: 2, updatedBy: "u2", id: "y", created: 2 },
      {
        exclude: ["a"],
        metaFields: ["updatedBy"],
        systemKeys: ["id", "created"],
      },
    );
    expect(changes).toEqual({});
  });

  test("respects include allowlist", () => {
    const changes = computeDiff(
      { a: 1, b: 2 },
      { a: 99, b: 99 },
      { include: ["a"] },
    );
    expect(Object.keys(changes)).toEqual(["a"]);
  });

  test("treats null/undefined before as add", () => {
    const changes = computeDiff(null, { a: 1 });
    expect(changes.a.oldValue).toBe(null);
    expect(changes.a.newValue).toBe(1);
  });

  test("treats null/undefined after as delete", () => {
    const changes = computeDiff({ a: 1 }, null);
    expect(changes.a.oldValue).toBe(1);
    expect(changes.a.newValue).toBe(null);
  });
});
