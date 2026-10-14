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

  test("UpdatableData does not descend into Timestamp, GeoPoint, or Record<string, V> and accepts computed string keys", () => {
    interface FakeTimestamp {
      readonly seconds: number;
      readonly nanoseconds: number;
      toDate(): Date;
      toMillis(): number;
      isEqual(other: FakeTimestamp): boolean;
      valueOf(): string;
    }

    interface FakeGeoPoint {
      readonly latitude: number;
      readonly longitude: number;
      isEqual(other: FakeGeoPoint): boolean;
    }

    interface PreventionModel {
      docId: string;
      createdAt: FakeTimestamp;
      updatedAt: FakeTimestamp;
      q0?: "pending" | "received" | "entered" | null;
      q5?: "pending" | "received" | "entered" | null;
      proConfirmationEmailDate?: Record<string, FakeTimestamp> | null;
      workshopAddress: {
        city: string;
        coordinates?: FakeGeoPoint | null;
      } | null;
    }

    type PreventionRepoConfig = RepositoryConfig<
      PreventionModel,
      readonly ["docId"],
      readonly [],
      true,
      (db: any, ruleDoc: string | null, docId: string) => any,
      {},
      "docId",
      undefined,
      "createdAt",
      "updatedAt"
    >;

    type PreventionUpdate = UpdatableData<PreventionRepoConfig>;

    const questionnaireTypeToField: Record<string, string> = {
      q0: "q0",
      q5: "q5",
    };
    const dynamicKey = questionnaireTypeToField["q0"]!;

    // Must accept computed string keys (e.g. { [questionnaireTypeToField[type]]: "pending" })
    const dynamicUpdate: PreventionUpdate = {
      [dynamicKey]: "pending",
    };

    // Must accept dot notation on plain nested objects
    const addressDotUpdate: PreventionUpdate = {
      "workshopAddress.city": "Paris",
    };

    // @ts-expect-error - must NOT generate dot paths inside Timestamp (.seconds)
    const invalidTimestampDot: PreventionUpdate = { "createdAt.seconds": 123 };

    expect((dynamicUpdate as Record<string, unknown>)[dynamicKey]).toBe("pending");
    expect(addressDotUpdate["workshopAddress.city"]).toBe("Paris");
    expect(invalidTimestampDot).toBeDefined();
  });
});
