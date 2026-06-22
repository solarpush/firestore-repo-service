/**
 * Tests for the admin Zod → form-field mapping, focused on the union handling:
 * a `z.union([z.literal(...), ...])` (a literal union, semantically an enum)
 * must render as a <select>, not a JSON textarea — and mixed unions still fall
 * back to JSON.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToFields } from "../../src/servers/admin/form-gen";

function field(schema: z.ZodType, name = "residenceType") {
  const fields = zodToFields(z.object({ [name]: schema }));
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error("field not found");
  return f;
}

describe("zodToFields — literal unions", () => {
  const ResidenceTypeSchema = z.union([
    z.literal("residence"),
    z.literal("prevention"),
    z.literal("ehpad"),
    z.literal("unknown"),
  ]);

  test("a union of string literals becomes a <select> with all options", () => {
    const f = field(ResidenceTypeSchema);
    expect(f.type).toBe("select");
    expect(f.options).toEqual([
      "residence",
      "prevention",
      "ehpad",
      "unknown",
    ]);
  });

  test("an optional literal union is still a <select>", () => {
    const f = field(ResidenceTypeSchema.optional());
    expect(f.type).toBe("select");
    expect(f.required).toBe(false);
    expect(f.options).toEqual([
      "residence",
      "prevention",
      "ehpad",
      "unknown",
    ]);
  });

  test("a nullable literal union is still a <select>", () => {
    const f = field(ResidenceTypeSchema.nullable());
    expect(f.type).toBe("select");
    expect(f.nullable).toBe(true);
  });

  test("parity: z.enum produces the same select shape", () => {
    const f = field(z.enum(["a", "b", "c"]));
    expect(f.type).toBe("select");
    expect(f.options).toEqual(["a", "b", "c"]);
  });

  test("a numeric literal union becomes a <select> of stringified values", () => {
    const f = field(z.union([z.literal(1), z.literal(2), z.literal(3)]));
    expect(f.type).toBe("select");
    expect(f.options).toEqual(["1", "2", "3"]);
  });

  test("a mixed (non-literal) union falls back to a JSON textarea", () => {
    const f = field(z.union([z.string(), z.number()]));
    expect(f.type).toBe("textarea");
    expect(f.hint).toBe("JSON");
  });
});

describe("zodToFields — transforms / effects", () => {
  test("z.string().transform(...) renders as a text input, not JSON", () => {
    const f = field(z.string().transform((v) => v.toUpperCase()));
    expect(f.type).toBe("text");
    expect(f.hint).not.toBe("JSON");
  });

  test("an optional transformed string is still a text input", () => {
    const f = field(z.string().transform((v) => v).optional());
    expect(f.type).toBe("text");
    expect(f.required).toBe(false);
  });

  test("a transformed number renders as a number input", () => {
    const f = field(z.number().transform((v) => v + 1));
    expect(f.type).toBe("number");
  });

  test("a refined string still renders as a text input", () => {
    const f = field(z.string().refine((v) => v.length > 0));
    expect(f.type).toBe("text");
  });

  test("a transformed literal union still renders as a <select>", () => {
    const f = field(
      z
        .union([z.literal("a"), z.literal("b")])
        .transform((v) => v),
    );
    expect(f.type).toBe("select");
    expect(f.options).toEqual(["a", "b"]);
  });
});
