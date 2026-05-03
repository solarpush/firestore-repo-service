import { describe, expect, test } from "bun:test";
import {
  buildIndexUrl,
  collectionIdFromPath,
  extractIndexUrl,
} from "../../src/servers/admin/index-url";

describe("collectionIdFromPath", () => {
  test("extracts last segment from simple path", () => {
    expect(collectionIdFromPath("posts")).toBe("posts");
  });

  test("extracts last segment from nested path", () => {
    expect(collectionIdFromPath("posts/{postId}/comments")).toBe("comments");
  });

  test("handles trailing slash", () => {
    expect(collectionIdFromPath("users/")).toBe("users");
  });
});

describe("buildIndexUrl", () => {
  test("generates URL for single-field collection query", () => {
    const url = buildIndexUrl("my-project", "posts", false, [
      { field: "status", op: "==", value: "active" },
    ]);

    expect(url).toContain(
      "https://console.firebase.google.com/v1/r/project/my-project/firestore/indexes",
    );
    expect(url).toContain("create_composite=");

    const json = JSON.parse(
      decodeURIComponent(url.split("create_composite=")[1]!),
    );
    expect(json.collectionGroup).toBe("posts");
    expect(json.queryScope).toBe("COLLECTION");
    expect(json.fields).toEqual([
      { fieldPath: "status", order: "ASCENDING" },
    ]);
  });

  test("generates URL for collection group", () => {
    const url = buildIndexUrl("my-project", "comments", true, [
      { field: "userId", op: "==", value: "abc" },
    ]);

    const json = JSON.parse(
      decodeURIComponent(url.split("create_composite=")[1]!),
    );
    expect(json.queryScope).toBe("COLLECTION_GROUP");
  });

  test("orders fields: equality → array → range → orderBy", () => {
    const url = buildIndexUrl(
      "proj",
      "posts",
      false,
      [
        { field: "createdAt", op: ">", value: "2024-01-01" },
        { field: "status", op: "==", value: "active" },
        { field: "tags", op: "array-contains", value: "news" },
      ],
      { field: "createdAt", dir: "desc" },
    );

    const json = JSON.parse(
      decodeURIComponent(url.split("create_composite=")[1]!),
    );
    expect(json.fields).toEqual([
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "tags", arrayConfig: "CONTAINS" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ]);
  });

  test("includes orderBy field not covered by filters", () => {
    const url = buildIndexUrl(
      "proj",
      "users",
      false,
      [{ field: "role", op: "==", value: "admin" }],
      { field: "name", dir: "asc" },
    );

    const json = JSON.parse(
      decodeURIComponent(url.split("create_composite=")[1]!),
    );
    expect(json.fields).toEqual([
      { fieldPath: "role", order: "ASCENDING" },
      { fieldPath: "name", order: "ASCENDING" },
    ]);
  });

  test("deduplicates fields (filter + sort on same field)", () => {
    const url = buildIndexUrl(
      "proj",
      "posts",
      false,
      [{ field: "createdAt", op: ">", value: "2024-01-01" }],
      { field: "createdAt", dir: "desc" },
    );

    const json = JSON.parse(
      decodeURIComponent(url.split("create_composite=")[1]!),
    );
    expect(json.fields).toHaveLength(1);
    expect(json.fields[0]).toEqual({
      fieldPath: "createdAt",
      order: "DESCENDING",
    });
  });
});

describe("extractIndexUrl", () => {
  test("extracts URL from Firestore error message", () => {
    const msg =
      '9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/my-proj/firestore/indexes?create_composite=abc123';
    expect(extractIndexUrl(msg)).toBe(
      "https://console.firebase.google.com/v1/r/project/my-proj/firestore/indexes?create_composite=abc123",
    );
  });

  test("returns undefined when no URL present", () => {
    const msg = "9 FAILED_PRECONDITION: The query requires an index.";
    expect(extractIndexUrl(msg)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractIndexUrl("")).toBeUndefined();
  });
});
