import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { UpdatableData } from "../../src/repositories/types";
import type {
  FieldPath,
  RepositoryConfig,
  WhereClause,
} from "../../src/shared/types";

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

  test("UpdatableData supports deep-partial objects and dot-notation keys", () => {
    type PostRepoConfig = RepositoryConfig<
      Post,
      readonly ["docId"],
      readonly [],
      false,
      (db: any, docId: string) => any,
      {},
      "docId"
    >;

    type PostUpdate = UpdatableData<PostRepoConfig>;

    const dotUpdate: PostUpdate = {
      "address.city": "Paris",
    };
    const nestedPartialUpdate: PostUpdate = {
      address: { city: "Lyon" },
    };
    const nullNestedUpdate: PostUpdate = {
      address: null,
    };

    // @ts-expect-error - invalid dot-notation key must be rejected
    const invalidKeyUpdate: PostUpdate = { "address.unknown": "Paris" };
    // @ts-expect-error - invalid value type on dot-notation key must be rejected
    const invalidValueUpdate: PostUpdate = { "address.city": 123 };

    expect(dotUpdate["address.city"]).toBe("Paris");
    expect(nestedPartialUpdate.address?.city).toBe("Lyon");
    expect(nullNestedUpdate.address).toBeNull();
    expect(invalidKeyUpdate).toBeDefined();
    expect(invalidValueUpdate).toBeDefined();
  });
});


