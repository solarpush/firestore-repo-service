import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

plugin({
  name: "raw-js-as-text-meili-types-test",
  setup(build) {
    build.onLoad({ filter: /\.raw\.js$/ }, (args) => ({
      contents: `export default ${JSON.stringify(
        readFileSync(args.path, "utf8"),
      )};`,
      loader: "js",
    }));
  },
});

const {
  createRepositoryConfig,
  createRepositoryMapping,
  createServers,
} = await import("../../src/index");

const {
  MeilisearchAdapter,
  defineMeilisearchAdapter,
} = await import("../../src/sync/index");

describe("MeilisearchAdapter type-safety and dot-notation autocompletion", () => {
  const adminUserSchema = z.object({
    docId: z.string(),
    baseUser: z.object({
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      number: z.number(),
      tel: z.string(),
      role: z.string(),
      active: z.boolean(),
    }),
    createdByName: z.string(),
    isFirstLogin: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  });

  const residenceSchema = z.object({
    docId: z.string(),
    number: z.number(),
    name: z.string(),
    invoiceEmail: z.string(),
    groupName: z.string(),
    address: z.object({
      city: z.string(),
      postalCode: z.string(),
      address: z.string(),
    }),
    telFix: z.string(),
    hubspotId: z.string(),
    active: z.boolean(),
    residenceType: z.string(),
    licenseId: z.string(),
    salesSegment: z.string(),
    userResSuperAdminId: z.string(),
    userProSuperAdminId: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
  });

  const repos = createRepositoryMapping(
    () => ({
      collection: () => ({ id: "ref" }),
      collectionGroup: () => ({ id: "ref" }),
      doc: () => ({ id: "ref" }),
    }) as any,
    {
      adminUsers: createRepositoryConfig(adminUserSchema)({
        path: "admin_users",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("admin_users").doc(docId),
      }),
      residences: createRepositoryConfig(residenceSchema)({
        path: "residences",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("residences").doc(docId),
      }),
    },
  );

  test("new MeilisearchAdapter with typeof repos generic validates nested fields", () => {
    const adapter = new MeilisearchAdapter<typeof repos>({
      client: { index: () => ({}), getIndex: async () => ({}) } as any,
      indexesSettings: {
        adminUsers: {
          searchableAttributes: [
            "docId",
            "baseUser.email",
            "baseUser.firstName",
            "baseUser.lastName",
            "baseUser.number",
            "baseUser.tel",
            "createdByName",
          ],
          filterableAttributes: [
            "docId",
            "baseUser.role",
            "baseUser.active",
            "baseUser.email",
            "isFirstLogin",
          ],
          sortableAttributes: [
            "createdAt",
            "updatedAt",
            "baseUser.firstName",
            "baseUser.lastName",
          ],
        },
        residences: {
          searchableAttributes: [
            "docId",
            "number",
            "name",
            "invoiceEmail",
            "groupName",
            "address.city",
            "address.postalCode",
            "address.address",
            "telFix",
            "hubspotId",
          ],
          filterableAttributes: [
            "docId",
            "number",
            "active",
            "residenceType",
            "groupName",
            "licenseId",
            "hubspotId",
            "salesSegment",
            "userResSuperAdminId",
            "userProSuperAdminId",
          ],
          sortableAttributes: ["createdAt", "updatedAt", "name", "number"],
        },
      },
    });

    expect(adapter.name).toBe("meilisearch");
    expect(adapter.indexesSettings?.adminUsers?.searchableAttributes).toContain("baseUser.email");
    expect(adapter.indexesSettings?.residences?.searchableAttributes).toContain("address.city");
  });

  test("defineMeilisearchAdapter helper creates factory with strict repo typing", () => {
    const factory = defineMeilisearchAdapter<typeof repos>({
      client: { index: () => ({}), getIndex: async () => ({}) } as any,
      indexesSettings: {
        adminUsers: {
          searchableAttributes: ["docId", "baseUser.email"],
          filterableAttributes: ["baseUser.active"],
        },
      },
    });

    const adapter = factory();
    expect(adapter.name).toBe("meilisearch");
    expect(adapter.indexesSettings?.adminUsers?.searchableAttributes).toEqual(["docId", "baseUser.email"]);
  });

  test("servers.meilisearchAdapter derives repos type automatically from createServers", () => {
    const servers = createServers(repos, {});

    const adapterFactory = servers.meilisearchAdapter({
      client: { index: () => ({}), getIndex: async () => ({}) } as any,
      indexesSettings: {
        adminUsers: {
          searchableAttributes: [
            "docId",
            "baseUser.email",
            "baseUser.firstName",
            "baseUser.lastName",
            "baseUser.number",
            "baseUser.tel",
            "createdByName",
          ],
          filterableAttributes: [
            "docId",
            "baseUser.role",
            "baseUser.active",
            "baseUser.email",
            "isFirstLogin",
          ],
          sortableAttributes: [
            "createdAt",
            "updatedAt",
            "baseUser.firstName",
            "baseUser.lastName",
          ],
        },
        residences: {
          searchableAttributes: [
            "docId",
            "number",
            "name",
            "invoiceEmail",
            "groupName",
            "address.city",
            "address.postalCode",
            "address.address",
            "telFix",
            "hubspotId",
          ],
          filterableAttributes: [
            "docId",
            "number",
            "active",
            "residenceType",
            "groupName",
            "licenseId",
            "hubspotId",
            "salesSegment",
            "userResSuperAdminId",
            "userProSuperAdminId",
          ],
          sortableAttributes: ["createdAt", "updatedAt", "name", "number"],
        },
      },
    });

    const adapter = adapterFactory();
    expect(adapter.name).toBe("meilisearch");
    expect(adapter.indexesSettings?.adminUsers?.searchableAttributes).toContain("baseUser.email");
    expect(adapter.indexesSettings?.residences?.searchableAttributes).toContain("address.city");
  });

  test("supports displayedAttributes and retrievableAttributes with strict field typing", async () => {
    let updatedSettings: any = null;
    const mockIndex = {
      updateSettings: async (settings: any) => {
        updatedSettings = settings;
      },
    };

    const adapter = new MeilisearchAdapter<typeof repos>({
      client: {
        index: () => mockIndex,
        getIndex: async () => ({}),
      } as any,
      indexesSettings: {
        adminUsers: {
          retrievableAttributes: ["docId", "baseUser.email", "baseUser.firstName"],
          displayedAttributes: ["docId", "baseUser.email", "createdByName"],
        },
      },
    });

    await adapter.ensureTarget({ targetName: "adminUsers", primaryKey: "docId" });
    expect(updatedSettings).toBeDefined();
    expect(updatedSettings.displayedAttributes).toEqual([
      "docId",
      "baseUser.email",
      "createdByName",
    ]);
  });
});
