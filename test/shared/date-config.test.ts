import { describe, expect, test } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  coerceToDate,
  getDateHandling,
  normalizeTimestamps,
  setDateHandling,
} from "../../src/shared/date-config";

describe("date-config", () => {
  test("default mode is preserve", () => {
    setDateHandling("preserve");
    expect(getDateHandling()).toBe("preserve");
  });

  test("setDateHandling switches mode", () => {
    setDateHandling("normalize");
    expect(getDateHandling()).toBe("normalize");
    setDateHandling("preserve");
    expect(getDateHandling()).toBe("preserve");
  });
});

describe("coerceToDate", () => {
  test("returns null for null/undefined", () => {
    expect(coerceToDate(null)).toBeNull();
    expect(coerceToDate(undefined)).toBeNull();
  });

  test("passes through valid Date", () => {
    const d = new Date("2024-01-15T10:30:00Z");
    expect(coerceToDate(d)).toBe(d);
  });

  test("returns null for invalid Date", () => {
    expect(coerceToDate(new Date("invalid"))).toBeNull();
  });

  test("converts Firestore Timestamp", () => {
    const ts = Timestamp.fromDate(new Date("2024-01-15T10:30:00Z"));
    const result = coerceToDate(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  test("converts {_seconds, _nanoseconds} payload", () => {
    const result = coerceToDate({ _seconds: 1705314600, _nanoseconds: 0 });
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  test("converts ISO string", () => {
    const result = coerceToDate("2024-01-15T10:30:00Z");
    expect(result?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  test("returns null for invalid ISO string", () => {
    expect(coerceToDate("not-a-date")).toBeNull();
  });

  test("converts numeric epoch ms", () => {
    const result = coerceToDate(1705314600000);
    expect(result?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });
});

describe("normalizeTimestamps", () => {
  test("converts Timestamp to Date at top level", () => {
    const ts = Timestamp.fromDate(new Date("2024-01-15T10:30:00Z"));
    const result = normalizeTimestamps(ts);
    expect(result).toBeInstanceOf(Date);
  });

  test("recursively converts inside plain objects", () => {
    const ts = Timestamp.fromDate(new Date("2024-01-15T10:30:00Z"));
    const result = normalizeTimestamps({
      docId: "a",
      createdAt: ts,
      meta: { updatedAt: ts },
    });
    expect(result.createdAt).toBeInstanceOf(Date);
    expect((result.meta as any).updatedAt).toBeInstanceOf(Date);
  });

  test("recursively converts inside arrays", () => {
    const ts = Timestamp.fromDate(new Date("2024-01-15T10:30:00Z"));
    const result = normalizeTimestamps({
      events: [{ at: ts }, { at: ts }],
    });
    expect((result.events as any)[0].at).toBeInstanceOf(Date);
    expect((result.events as any)[1].at).toBeInstanceOf(Date);
  });

  test("leaves non-timestamp values untouched", () => {
    const input = {
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
      date: new Date("2024-01-15T10:30:00Z"),
    };
    const result = normalizeTimestamps(input);
    expect(result.str).toBe("hello");
    expect(result.num).toBe(42);
    expect(result.bool).toBe(true);
    expect(result.nil).toBeNull();
    expect(result.date).toBeInstanceOf(Date);
  });

  test("preserves non-plain objects (e.g. class instances)", () => {
    class Custom {
      readonly tag = "x";
    }
    const c = new Custom();
    const result = normalizeTimestamps({ c });
    expect(result.c).toBe(c);
  });
});
