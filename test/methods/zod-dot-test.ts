import { describe, expect, test } from "bun:test";
import { z } from "zod";

function unwrapZodType(zodType: any): any {
  let cur = zodType;
  while (cur) {
    const def = cur._zod?.def ?? cur._def;
    if (!def) break;
    if (def.innerType) {
      cur = def.innerType;
    } else if (def.schema) {
      cur = def.schema;
    } else if (
      def.type === "optional" ||
      def.type === "nullable" ||
      def.type === "default" ||
      def.type === "catch" ||
      def.type === "effects"
    ) {
      cur = def.innerType ?? def.schema;
    } else {
      break;
    }
  }
  return cur;
}

function resolveFieldPathSchema(entrySchema: any, path: string): any {
  const parts = path.split(".");
  let cur = unwrapZodType(entrySchema);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const shape: Record<string, any> | undefined = (cur as any)?.shape;
    if (!shape || !shape[part]) {
      return undefined;
    }
    const rawSub = shape[part];
    if (i === parts.length - 1) {
      return rawSub;
    }
    cur = unwrapZodType(rawSub);
  }
  return cur;
}

function makeDeepPartial(s: z.ZodType): z.ZodType {
  const unwrapped = unwrapZodType(s);
  const def = (unwrapped as any)?._zod?.def ?? (unwrapped as any)?._def;
  const typeName = def?.typeName ?? def?.type;
  if (typeName === "ZodObject" || typeName === "object") {
    const shape = (unwrapped as z.ZodObject<any>).shape;
    const newShape: Record<string, z.ZodType> = {};
    for (const [k, v] of Object.entries(shape)) {
      newShape[k] = makeDeepPartial(v as z.ZodType);
    }
    return z.object(newShape).partial();
  }
  return s;
}

const userSchema = z.object({
  docId: z.string(),
  name: z.string(),
  address: z.object({
    city: z.string(),
    zip: z.string(),
  }),
});

describe("Dot notation and Deep Partial validation", () => {
  test("resolveFieldPathSchema resolves nested dot notation schema", () => {
    const citySchema = resolveFieldPathSchema(userSchema, "address.city");
    expect(citySchema).toBeDefined();
    const parsed = citySchema.parse("Paris");
    expect(parsed).toBe("Paris");
  });

  test("makeDeepPartial allows partial nested objects", () => {
    const partialSchema = makeDeepPartial(userSchema) as z.ZodObject<any>;
    const parsed = partialSchema.parse({ address: { city: "Lyon" } });
    expect(parsed.address?.city).toBe("Lyon");
  });
});
