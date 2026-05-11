/**
 * Runtime type-mismatch detection between a column's declared Zod schema
 * and the actual value returned by Firestore.
 *
 * Used by the list view to surface a small warning indicator + tooltip
 * when the stored data drifts from the model (e.g. the schema declares a
 * `string` but Firestore returns a `number`).
 */

import type { z } from "zod";
import {
  getInnerType,
  getShape,
  getTypeName,
} from "../../../shared/zod-compat";

export type ExpectedType =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "array"
  | "object"
  | "enum"
  | "literal"
  | "unknown";

/** Resolve the expected runtime type name from a Zod schema (after unwrapping optional/nullable/default). */
export function expectedTypeOf(schema: z.ZodType | undefined): ExpectedType {
  if (!schema) return "unknown";
  const inner = unwrap(schema);
  const tn = getTypeName(inner);
  switch (tn) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBigInt":
      return "bigint";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "date";
    case "ZodArray":
      return "array";
    case "ZodObject":
    case "ZodRecord":
      return "object";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "enum";
    case "ZodLiteral":
      return "literal";
    default:
      return "unknown";
  }
}

/** Recursively unwrap Optional/Nullable/Default wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  const tn = getTypeName(schema);
  if (
    tn === "ZodOptional" ||
    tn === "ZodNullable" ||
    tn === "ZodDefault"
  ) {
    const inner = getInnerType(schema);
    return inner ? unwrap(inner) : schema;
  }
  return schema;
}

/** Resolve a Zod schema for a possibly dot-noted column path, returning undefined if unresolvable. */
export function resolveAtPath(
  schema: z.ZodType | undefined,
  path: string,
): z.ZodType | undefined {
  if (!schema) return undefined;
  const segments = path.split(".");
  let cur: z.ZodType | undefined = schema;
  for (const seg of segments) {
    if (!cur) return undefined;
    const inner = unwrap(cur);
    const tn = getTypeName(inner);
    if (tn !== "ZodObject") return undefined;
    const shape = getShape(inner);
    cur = shape[seg];
  }
  return cur;
}

/** Best-effort runtime type label of a value, mirroring ExpectedType vocabulary. */
export function actualTypeOf(val: unknown): ExpectedType | "null" {
  if (val === null || val === undefined) return "null";
  if (val instanceof Date) return "date";
  if (Array.isArray(val)) return "array";
  if (typeof val === "string") return "string";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "bigint") return "bigint";
  if (typeof val === "number") return "number";
  if (typeof val === "object") {
    // Firestore Timestamp duck-typing
    if (typeof (val as any).toDate === "function") return "date";
    return "object";
  }
  return "unknown";
}

/** Return null if compatible; otherwise a tooltip message describing the mismatch. */
export function mismatchMessage(
  expected: ExpectedType,
  val: unknown,
): string | null {
  if (expected === "unknown") return null;
  const actual = actualTypeOf(val);
  // Null is acceptable here — nullability is a separate concern handled by the schema (optional/nullable).
  if (actual === "null") return null;
  // enum/literal compatibility — both stored as primitives; we don't validate the value set here.
  if (expected === "enum" || expected === "literal") {
    if (actual === "string" || actual === "number") return null;
    return `Expected ${expected} (string/number), got ${actual}`;
  }
  if (expected === actual) return null;
  // Cross-compatible numerics: bigint vs number
  if (
    (expected === "number" && actual === "bigint") ||
    (expected === "bigint" && actual === "number")
  ) {
    return null;
  }
  return `Expected ${expected}, got ${actual}`;
}
