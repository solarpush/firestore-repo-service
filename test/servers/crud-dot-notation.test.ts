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

const { createRepositoryConfig, createRepositoryMapping } = await import(
  "../../src/index"
);
const { createServers } = await import("../../src/servers/index");

const userSchema = z.object({
  docId: z.string(),
  name: z.string(),
  address: z.object({
    city: z.string(),
    zip: z.string(),
  }),
});

function makeFakeFirestore(store: Record<string, any> = {}) {
  const collectionRef = {
    doc: (id: string) => ({
      path: `users/${id}`,
      get: async () => ({
        exists: true,
        data: () => store[id] || { docId: id, name: "John", address: { city: "Lyon", zip: "69000" } },
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
  const repos = createRepositoryMapping(
    () => makeFakeFirestore(store),
    {
      users: createRepositoryConfig(userSchema)({
        path: "users",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("users").doc(docId),
      }),
    },
  );

  test("PATCH document update handles dot notation key 'address.city' correctly", async () => {
    // Perform update via repo.update directly with dot notation
    const result = await repos.users.update("u1", { "address.city": "Paris" });
    expect(result).toBeDefined();
    expect(store["u1"]["address.city"]).toBe("Paris");
  });
});
