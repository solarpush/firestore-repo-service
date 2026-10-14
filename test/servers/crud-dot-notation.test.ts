import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

plugin({
  name: "raw-js-as-text",
  setup(build) {
    build.onLoad({ filter: /\.raw\.js$/ }, (args) => ({
      contents: `export default ${JSON.stringify(
        readFileSync(args.path, "utf8"),
      )};`,
      loader: "js",
    }));
  },
});

const { createRepositoryConfig, createRepositoryMapping } =
  await import("../../src/index");
const { createCrudHandlers } = await import("../../src/servers/crud/handlers");
const { generateOpenAPISpec } = await import("../../src/servers/crud/openapi");
const { Hono } = await import("hono");

const userSchema = z.object({
  docId: z.string(),
  name: z.string(),
  address: z
    .object({
      city: z.string(),
      zip: z.string(),
      geo: z
        .object({
          lat: z.number(),
          lng: z.number(),
        })
        .nullable(),
    })
    .nullable(),
});

function makeFakeFirestore(store: Record<string, any> = {}) {
  const collectionRef = {
    doc: (id: string) => ({
      path: `users/${id}`,
      get: async () => ({
        exists: true,
        data: () =>
          store[id] || {
            docId: id,
            name: "John",
            address: {
              city: "Lyon",
              zip: "69000",
              geo: { lat: 45.75, lng: 4.85 },
            },
          },
      }),
      update: async (updates: any) => {
        store[id] = { ...(store[id] || {}), ...updates };
        return {
          data: () => ({ docId: id, name: "John", ...store[id] }),
        };
      },
    }),
  };

  return {
    collection: () => collectionRef,
    collectionGroup: () => collectionRef,
  } as any;
}

describe("CRUD server dot notation and deep partial PATCH updates", () => {
  const store: Record<string, any> = {};
  const repos = createRepositoryMapping(() => makeFakeFirestore(store), {
    users: createRepositoryConfig(userSchema)({
      path: "users",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("users").doc(docId),
    }),
  });

  test("PATCH document update handles dot notation key 'address.city' correctly", async () => {
    const result = await repos.users.update("u1", { "address.city": "Paris" });
    expect(result).toBeDefined();
    expect(store["u1"]["address.city"]).toBe("Paris");
  });

  test("OpenAPI spec generates a deep-partial UserPatch schema for PATCH and BatchUpdateOperation", () => {
    const registry: any = {
      users: {
        name: "users",
        path: "users",
        repo: repos.users,
        schema: userSchema,
        systemKeys: ["docId"],
        documentKey: "docId",
        pageSize: 25,
        allowDelete: false,
      },
    };

    const spec = generateOpenAPISpec(registry, "/api");

    // 1. PUT keeps UserUpdate (full replace with required top-level fields)
    const putBodySchema =
      spec.paths["/api/users/{docId}"]?.put?.requestBody &&
      (spec.paths["/api/users/{docId}"].put.requestBody as any).content[
        "application/json"
      ].schema;
    expect(putBodySchema).toEqual({ $ref: "#/components/schemas/UserUpdate" });
    const userUpdateSchema = spec.components.schemas["UserUpdate"] as any;
    expect(userUpdateSchema.required).toEqual(["name", "address"]);

    // 2. PATCH references UserPatch directly (no allOf wrapper around UserUpdate)
    const patchBodySchema =
      spec.paths["/api/users/{docId}"]?.patch?.requestBody &&
      (spec.paths["/api/users/{docId}"].patch.requestBody as any).content[
        "application/json"
      ].schema;
    expect(patchBodySchema).toEqual({ $ref: "#/components/schemas/UserPatch" });

    // 3. BatchUpdateOperation also references UserPatch
    const batchUpdateSchema = spec.components.schemas[
      "UserBatchUpdateOperation"
    ] as any;
    expect(batchUpdateSchema.properties.data).toEqual({
      $ref: "#/components/schemas/UserPatch",
    });

    // 4. UserPatch has no required top-level fields and all nested objects are also partial
    const userPatchSchema = spec.components.schemas["UserPatch"] as any;
    expect(userPatchSchema).toBeDefined();
    expect(userPatchSchema.required).toBeUndefined();

    // Check address is nullable and its inner object has no required fields
    const addressSchema = userPatchSchema.properties.address;
    expect(addressSchema.anyOf).toBeDefined();
    const addressObjBranch = addressSchema.anyOf.find(
      (b: any) => b.type === "object",
    );
    const addressNullBranch = addressSchema.anyOf.find(
      (b: any) => b.type === "null",
    );
    expect(addressObjBranch).toBeDefined();
    expect(addressNullBranch).toBeDefined();
    expect(addressObjBranch.required).toBeUndefined();
    expect(addressObjBranch.properties.city).toEqual({ type: "string" });
    expect(addressObjBranch.properties.zip).toEqual({ type: "string" });

    // Check deeply nested address.geo is also partial and nullable
    const geoSchema = addressObjBranch.properties.geo;
    expect(geoSchema.anyOf).toBeDefined();
    const geoObjBranch = geoSchema.anyOf.find((b: any) => b.type === "object");
    const geoNullBranch = geoSchema.anyOf.find((b: any) => b.type === "null");
    expect(geoObjBranch).toBeDefined();
    expect(geoNullBranch).toBeDefined();
    expect(geoObjBranch.required).toBeUndefined();
    expect(geoObjBranch.properties.lat).toEqual({ type: "number" });
    expect(geoObjBranch.properties.lng).toEqual({ type: "number" });

    // Check dot-notation object property "address.geo" is also partial
    const dotGeoSchema = userPatchSchema.properties["address.geo"];
    const dotGeoObjBranch = dotGeoSchema.anyOf.find(
      (b: any) => b.type === "object",
    );
    expect(dotGeoObjBranch.required).toBeUndefined();
  });

  test("Runtime PATCH handler accepts partial top-level, nested partial objects, and null on nullable nested objects", async () => {
    const registry: any = {
      users: {
        name: "users",
        path: "users",
        repo: repos.users,
        schema: userSchema,
        systemKeys: ["docId"],
        documentKey: "docId",
        pageSize: 25,
        allowDelete: false,
      },
    };

    const handlers = createCrudHandlers(registry, "", true);
    const app = new Hono();
    app.patch("/users/:id", async (c) => {
      const body = await c.req.json();
      return handlers.handleUpdate({ c, input: body }, true);
    });

    // 1. Nested partial object (only city, omitting zip and geo, and omitting top-level name)
    const res1 = await app.request("/users/u1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: { city: "Marseille" } }),
    });
    expect(res1.status).toBe(200);

    // 2. Deeply nested partial object (only address.geo.lat)
    const res2 = await app.request("/users/u1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: { geo: { lat: 43.3 } } }),
    });
    expect(res2.status).toBe(200);

    // 3. Setting nullable nested object to null
    const res3 = await app.request("/users/u1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: null }),
    });
    expect(res3.status).toBe(200);

    // 4. Dot-notation nested partial object
    const res4 = await app.request("/users/u1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "address.geo": { lng: 5.37 } }),
    });
    expect(res4.status).toBe(200);
  });
});
