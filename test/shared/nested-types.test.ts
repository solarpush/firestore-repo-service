import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { FieldPath, WhereClause } from "../../src/shared/types";

describe("FieldPath and WhereClause with optional and nullable fields", () => {
  const postSchema = z.object({
    docId: z.string(),
    title: z.string(),
    address: z
      .object({
        street: z.string(),
        city: z.string(),
      })
      .optional()
      .nullable(),
  });

  type Post = z.infer<typeof postSchema>;

  test("FieldPath includes nested properties of optional & nullable object", () => {
    type PostFieldPath = FieldPath<Post>;

    // Type assertions
    const validPaths: PostFieldPath[] = [
      "docId",
      "title",
      "address",
      "address.street",
      "address.city",
    ];
    expect(validPaths).toHaveLength(5);
  });

  test("WhereClause supports nested dot notation and null equality on optional & nullable object", () => {
    const whereNested: WhereClause<Post>[] = [
      ["address.city", "==", "Paris"],
    ];
    const whereNull: WhereClause<Post>[] = [
      ["address", "==", null],
    ];

    expect(whereNested).toBeDefined();
    expect(whereNull).toBeDefined();
  });
});
