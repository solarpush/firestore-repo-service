/**
 * Zod introspection utilities — compatible with Zod 4.
 *
 * Centralizes all internal `_zod.def` accesses so the rest of the codebase
 * never touches Zod internals directly.  If a future Zod version changes
 * the internal layout, only this file needs updating.
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Type-name resolution
// ---------------------------------------------------------------------------

/**
 * Canonical Zod type names used in the codebase.
 * These match the **Zod 3** naming convention (e.g. "ZodString") that the
 * form-gen / admin handlers already rely on, so we don't need to rewrite
 * every `case "ZodString":` branch.
 */
type ZodTypeName =
  | "ZodString"
  | "ZodNumber"
  | "ZodBigInt"
  | "ZodBoolean"
  | "ZodDate"
  | "ZodEnum"
  | "ZodNativeEnum"
  | "ZodLiteral"
  | "ZodObject"
  | "ZodArray"
  | "ZodOptional"
  | "ZodNullable"
  | "ZodDefault"
  | "ZodCoerce"
  | "ZodUnion"
  | "ZodUndefined"
  | "ZodUnknown"
  | "ZodAny"
  | "ZodRecord"
  | string;

/**
 * Map from Zod 4 `_zod.def.type` (lowercase) → Zod 3 `_def.typeName` format.
 * Any key not in this map is capitalised as `Zod${Capitalised}`.
 */
const TYPE_MAP: Record<string, ZodTypeName> = {
  string: "ZodString",
  number: "ZodNumber",
  bigint: "ZodBigInt",
  boolean: "ZodBoolean",
  date: "ZodDate",
  enum: "ZodEnum",
  nativeEnum: "ZodNativeEnum",
  literal: "ZodLiteral",
  object: "ZodObject",
  array: "ZodArray",
  optional: "ZodOptional",
  nullable: "ZodNullable",
  default: "ZodDefault",
  coerce: "ZodCoerce",
  union: "ZodUnion",
  undefined: "ZodUndefined",
  unknown: "ZodUnknown",
  any: "ZodAny",
  record: "ZodRecord",
};

/**
 * Get the canonical type name of a Zod schema.
 *
 * Works with both Zod 3 (`_def.typeName`) and Zod 4 (`_zod.def.type`).
 * Returns names in Zod-3 style ("ZodString", "ZodObject" …) for
 * backward-compatible switch/case usage.
 */
export function getTypeName(schema: z.ZodType): ZodTypeName {
  const s = schema as any;

  // Zod 4 path
  const v4Type: string | undefined = s._zod?.def?.type;
  if (v4Type)
    return (
      TYPE_MAP[v4Type] ??
      `Zod${v4Type.charAt(0).toUpperCase()}${v4Type.slice(1)}`
    );

  // Zod 3 fallback
  const v3Type: string | undefined = s._def?.typeName;
  if (v3Type) return v3Type;

  return "";
}

// ---------------------------------------------------------------------------
// Unwrapping wrappers (Optional / Nullable / Default)
// ---------------------------------------------------------------------------

/**
 * Get the inner schema from a wrapper type (Optional / Nullable / Default).
 */
export function getInnerType(schema: z.ZodType): z.ZodType | undefined {
  const s = schema as any;

  // Zod 4: _zod.def.innerType
  if (s._zod?.def?.innerType) return s._zod.def.innerType;

  // Zod 3 compat: _def.innerType
  if (s._def?.innerType) return s._def.innerType;

  return undefined;
}

/**
 * Get the **element schema** from a `ZodArray`.
 * Returns `undefined` for non-array schemas.
 */
export function getArrayElementType(
  schema: z.ZodType,
): z.ZodType | undefined {
  const s = schema as any;

  // Zod 4: _zod.def.element
  if (s._zod?.def?.element) return s._zod.def.element;

  // Zod 3: _def.type (ZodArray stores element schema in _def.type)
  if (s._def?.type) return s._def.type;

  return undefined;
}

/**
 * Returns the list of **required** (non-optional) top-level keys of a ZodObject.
 * A key is required when its schema is NOT wrapped in ZodOptional.
 * ZodNullable / ZodDefault fields are still considered required — they must be present.
 */
export function getRequiredSchemaKeys(schema: z.ZodObject<any>): string[] {
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    const typeName = getTypeName(fieldSchema as z.ZodType);
    if (typeName !== "ZodOptional") {
      required.push(key);
    }
  }
  return required;
}

/**
 * Get the default value for a ZodDefault schema.
 * In Zod 3 this was `_def.defaultValue()` (function). In Zod 4 it's a direct value.
 */
export function getDefaultValue(schema: z.ZodType): unknown {
  const s = schema as any;

  // Zod 4
  if (s._zod?.def?.defaultValue !== undefined) return s._zod.def.defaultValue;

  // Zod 3 compat
  const v = s._def?.defaultValue;
  if (typeof v === "function") return v();
  return v;
}

// ---------------------------------------------------------------------------
// Object shape
// ---------------------------------------------------------------------------

/**
 * Get the shape of a ZodObject schema (Record<string, ZodType>).
 * Handles both Zod 3 (`_def.shape()` function) and Zod 4 (`.shape` property).
 */
export function getShape(schema: z.ZodType): Record<string, z.ZodType> {
  const s = schema as any;

  // Direct `.shape` property (Zod 3 & 4 for ZodObject instances)
  if (s.shape && typeof s.shape === "object") return s.shape;

  // Zod 4: _zod.def.shape
  if (s._zod?.def?.shape && typeof s._zod.def.shape === "object")
    return s._zod.def.shape;

  // Zod 3 fallback: _def.shape() or _def.shape
  if (s._def?.shape) {
    return typeof s._def.shape === "function" ? s._def.shape() : s._def.shape;
  }

  return {};
}

// ---------------------------------------------------------------------------
// Enum / Literal values
// ---------------------------------------------------------------------------

/**
 * Get the values of a ZodEnum schema as a string[].
 */
export function getEnumValues(schema: z.ZodType): string[] {
  const s = schema as any;

  // Zod 4: `.options` or `_zod.def.entries`
  if (Array.isArray(s.options)) return s.options;
  if (s._zod?.def?.entries)
    return Object.values(s._zod.def.entries) as string[];

  // Zod 3: `_def.values`
  if (Array.isArray(s._def?.values)) return s._def.values;

  return [];
}

/**
 * Get the value object of a ZodNativeEnum schema.
 */
export function getNativeEnumValues(
  schema: z.ZodType,
): Record<string, unknown> {
  const s = schema as any;

  // Zod 4: `_zod.def.entries` or `.enum`
  if (s._zod?.def?.entries) return s._zod.def.entries;
  if (s.enum && typeof s.enum === "object") return s.enum;

  // Zod 3: `_def.values`
  if (s._def?.values && typeof s._def.values === "object") return s._def.values;

  return {};
}

/**
 * Get the value of a ZodLiteral schema.
 */
export function getLiteralValue(schema: z.ZodType): unknown {
  const s = schema as any;

  // Zod 4: `_zod.def.values[0]`
  if (Array.isArray(s._zod?.def?.values)) return s._zod.def.values[0];

  // Zod 3: `_def.value`
  return s._def?.value;
}

// ---------------------------------------------------------------------------
// String checks
// ---------------------------------------------------------------------------

/**
 * Get relevant "check kinds" from a ZodString schema.
 * Returns an array of kind strings: "email", "url", etc.
 */
export function getStringChecks(schema: z.ZodType): string[] {
  const s = schema as any;
  const kinds: string[] = [];

  // Zod 4: checks with `.format` field
  const v4Checks: any[] | undefined = s._zod?.def?.checks;
  if (Array.isArray(v4Checks)) {
    for (const c of v4Checks) {
      if (c.format) kinds.push(c.format);
    }
    if (kinds.length > 0) return kinds;
  }

  // Zod 3: _def.checks with `.kind` field
  const v3Checks: any[] | undefined = s._def?.checks;
  if (Array.isArray(v3Checks)) {
    for (const c of v3Checks) {
      if (c.kind) kinds.push(c.kind);
    }
  }

  return kinds;
}
