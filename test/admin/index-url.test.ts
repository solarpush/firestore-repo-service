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

// ── Tiny protobuf decoder (for tests) ───────────────────────────────────────
// Decodes the subset of wire format produced by buildIndexUrl/buildExemptionUrl.

interface DecodedField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
}

interface DecodedPayload {
  resource: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: DecodedField[];
}

function decodeVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (true) {
    const byte = buf[pos++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

function decodeIndexField(buf: Uint8Array): DecodedField {
  let pos = 0;
  const out: DecodedField = { fieldPath: "" };
  while (pos < buf.length) {
    const tag = buf[pos++]!;
    const fieldNum = tag >> 3;
    const wire = tag & 0x07;
    if (fieldNum === 1 && wire === 2) {
      const [len, p2] = decodeVarint(buf, pos);
      out.fieldPath = new TextDecoder().decode(buf.slice(p2, p2 + len));
      pos = p2 + len;
    } else if (fieldNum === 2 && wire === 0) {
      const [v, p2] = decodeVarint(buf, pos);
      out.order = v === 2 ? "DESCENDING" : "ASCENDING";
      pos = p2;
    } else if (fieldNum === 3 && wire === 0) {
      const [_v, p2] = decodeVarint(buf, pos);
      out.arrayConfig = "CONTAINS";
      pos = p2;
    } else {
      throw new Error(`Unexpected tag ${tag}`);
    }
  }
  return out;
}

function decodeProtoPayload(b64: string): DecodedPayload {
  const bin = Buffer.from(b64, "base64");
  const buf = new Uint8Array(bin);
  const out: DecodedPayload = {
    resource: "",
    queryScope: "COLLECTION",
    fields: [],
  };
  let pos = 0;
  while (pos < buf.length) {
    const tag = buf[pos++]!;
    const fieldNum = tag >> 3;
    const wire = tag & 0x07;
    if (fieldNum === 1 && wire === 2) {
      const [len, p2] = decodeVarint(buf, pos);
      out.resource = new TextDecoder().decode(buf.slice(p2, p2 + len));
      pos = p2 + len;
    } else if (fieldNum === 2 && wire === 0) {
      const [v, p2] = decodeVarint(buf, pos);
      out.queryScope = v === 2 ? "COLLECTION_GROUP" : "COLLECTION";
      pos = p2;
    } else if (fieldNum === 3 && wire === 2) {
      const [len, p2] = decodeVarint(buf, pos);
      out.fields.push(decodeIndexField(buf.slice(p2, p2 + len)));
      pos = p2 + len;
    } else {
      throw new Error(`Unexpected tag ${tag}`);
    }
  }
  return out;
}

function parseUrl(url: string): { param: "create_composite" | "create_exemption"; payload: DecodedPayload } {
  const compMatch = url.match(/[?&]create_composite=([^&]+)/);
  if (compMatch) {
    return {
      param: "create_composite",
      payload: decodeProtoPayload(decodeURIComponent(compMatch[1]!)),
    };
  }
  const exMatch = url.match(/[?&]create_exemption=([^&]+)/);
  if (exMatch) {
    return {
      param: "create_exemption",
      payload: decodeProtoPayload(decodeURIComponent(exMatch[1]!)),
    };
  }
  throw new Error(`No create_composite or create_exemption in URL: ${url}`);
}

describe("buildIndexUrl", () => {
  test("single-field collection query → composite (with __name__)", () => {
    const url = buildIndexUrl("my-project", "posts", false, [
      { field: "status", op: "==", value: "active" },
    ]);

    expect(url).toContain(
      "https://console.firebase.google.com/project/my-project/firestore/databases/-default-/indexes",
    );
    const { param, payload } = parseUrl(url);
    expect(param).toBe("create_composite");
    expect(payload.resource).toBe(
      "projects/my-project/databases/(default)/collectionGroups/posts/indexes/_",
    );
    expect(payload.queryScope).toBe("COLLECTION");
    expect(payload.fields).toEqual([
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "__name__", order: "ASCENDING" },
    ]);
  });

  test("single-field collection-group query → exemption", () => {
    const url = buildIndexUrl("my-project", "comments", true, [
      { field: "userId", op: "==", value: "abc" },
    ]);

    expect(url).toContain(
      "https://console.firebase.google.com/project/my-project/firestore/databases/-default-/indexes/automatic",
    );
    const { param, payload } = parseUrl(url);
    expect(param).toBe("create_exemption");
    expect(payload.resource).toBe(
      "projects/my-project/databases/(default)/collectionGroups/comments/fields/userId",
    );
    expect(payload.queryScope).toBe("COLLECTION_GROUP");
    expect(payload.fields).toEqual([{ fieldPath: "userId", order: "ASCENDING" }]);
  });

  test("multi-field collection-group → composite COLLECTION_GROUP", () => {
    const url = buildIndexUrl(
      "firestore-repo-services",
      "comments",
      true,
      [{ field: "docId", op: "==", value: "x" }],
      { field: "createdAt", dir: "asc" },
    );
    const { param, payload } = parseUrl(url);
    expect(param).toBe("create_composite");
    expect(payload.queryScope).toBe("COLLECTION_GROUP");
    expect(payload.fields).toEqual([
      { fieldPath: "docId", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "ASCENDING" },
      { fieldPath: "__name__", order: "ASCENDING" },
    ]);
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

    const { payload } = parseUrl(url);
    expect(payload.fields).toEqual([
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "tags", arrayConfig: "CONTAINS" },
      { fieldPath: "createdAt", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
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

    const { payload } = parseUrl(url);
    expect(payload.fields).toEqual([
      { fieldPath: "role", order: "ASCENDING" },
      { fieldPath: "name", order: "ASCENDING" },
      { fieldPath: "__name__", order: "ASCENDING" },
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

    const { payload } = parseUrl(url);
    expect(payload.fields).toEqual([
      { fieldPath: "createdAt", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
    ]);
  });

  test("matches a real Firebase Console exemption URL byte-for-byte", () => {
    const url = buildIndexUrl(
      "firestore-repo-services",
      "comments",
      true,
      [{ field: "docId", op: "==", value: "fff" }],
    );
    const expected =
      "Cltwcm9qZWN0cy9maXJlc3RvcmUtcmVwby1zZXJ2aWNlcy9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb25Hcm91cHMvY29tbWVudHMvZmllbGRzL2RvY0lkEAIaCQoFZG9jSWQQAQ";
    const got = decodeURIComponent(url.split("create_exemption=")[1]!);
    expect(got).toBe(expected);
  });

  test("matches a real Firebase Console composite URL byte-for-byte", () => {
    const url = buildIndexUrl(
      "firestore-repo-services",
      "comments",
      true,
      [{ field: "docId", op: "==", value: "x" }],
      { field: "createdAt", dir: "asc" },
    );
    const expected =
      "Clhwcm9qZWN0cy9maXJlc3RvcmUtcmVwby1zZXJ2aWNlcy9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb25Hcm91cHMvY29tbWVudHMvaW5kZXhlcy9fEAIaCQoFZG9jSWQQARoNCgljcmVhdGVkQXQQARoMCghfX25hbWVfXxAB";
    const got = decodeURIComponent(url.split("create_composite=")[1]!);
    expect(got).toBe(expected);
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
