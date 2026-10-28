import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import type { Firestore } from "firebase-admin/firestore";
import { Hono } from "hono";
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

const { createHistoryTriggers } = await import("../../src/history/triggers");
const {
  buildRepositoryRelations,
  createRepositoryConfig,
  createRepositoryMapping,
} = await import("../../src/index");
const { createRepository } = await import("../../src/repositories/factory");
const { generateOpenAPISpec } = await import("../../src/servers/crud");
const { createCrudHandlers } = await import("../../src/servers/crud/handlers");
const {
  extractPathArgsFromDoc,
  parsePathTemplate,
} = await import("../../src/shared/path-template");
const { createSyncTriggers } = await import("../../src/sync/triggers");

// ---------------------------------------------------------------------------
// In-memory Firestore Mock
// ---------------------------------------------------------------------------

function createInMemoryFirestore() {
  const store = new Map<string, Record<string, any>>();

  function makeDocRef(docPath: string): any {
    const cleanPath = docPath.replace(/^\/+|\/+$/g, "");
    const segments = cleanPath.split("/");
    const id = segments[segments.length - 1]!;
    return {
      id,
      path: cleanPath,
      firestore: db,
      async set(data: Record<string, any>) {
        store.set(cleanPath, structuredClone(data));
      },
      async update(data: Record<string, any>) {
        const existing = store.get(cleanPath) ?? {};
        store.set(cleanPath, { ...existing, ...structuredClone(data) });
      },
      async delete() {
        store.delete(cleanPath);
      },
      async get() {
        const data = store.get(cleanPath);
        return {
          id,
          ref: makeDocRef(cleanPath),
          exists: data !== undefined,
          data: () => (data ? structuredClone(data) : undefined),
        };
      },
      collection(subName: string) {
        return makeCollectionRef(`${cleanPath}/${subName}`);
      },
    };
  }

  function makeCollectionRef(colPath: string): any {
    const cleanColPath = colPath.replace(/^\/+|\/+$/g, "");
    let randomCounter = 0;
    return {
      id: cleanColPath.split("/").pop()!,
      path: cleanColPath,
      firestore: db,
      doc(docId?: string) {
        const resolvedId = docId ?? `auto_id_${++randomCounter}`;
        return makeDocRef(`${cleanColPath}/${resolvedId}`);
      },
    };
  }

  function makeCollectionGroupQuery(collectionId: string): any {
    const filters: Array<{ field: string; op: string; value: any }> = [];
    let limitVal: number | undefined;

    const queryObj: any = {
      firestore: db,
      where(field: string, op: string, value: any) {
        filters.push({ field, op, value });
        return queryObj;
      },
      limit(n: number) {
        limitVal = n;
        return queryObj;
      },
      async get() {
        const docs: any[] = [];
        for (const [docPath, data] of store.entries()) {
          const segments = docPath.split("/");
          // Collection segment for this document is at segments.length - 2
          const colSeg = segments[segments.length - 2];
          if (colSeg !== collectionId) continue;

          const matches = filters.every((f) => {
            if (f.op === "==") return data[f.field] === f.value;
            return true;
          });
          if (matches) {
            docs.push({
              id: segments[segments.length - 1]!,
              ref: makeDocRef(docPath),
              exists: true,
              data: () => structuredClone(data),
            });
          }
        }
        const sliced = limitVal !== undefined ? docs.slice(0, limitVal) : docs;
        return {
          empty: sliced.length === 0,
          size: sliced.length,
          docs: sliced,
        };
      },
    };
    return queryObj;
  }

  const db: any = {
    store,
    doc(docPath: string) {
      return makeDocRef(docPath);
    },
    collection(colPath: string) {
      return makeCollectionRef(colPath);
    },
    collectionGroup(collectionId: string) {
      return makeCollectionGroupQuery(collectionId);
    },
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        set(ref: any, data: any) {
          ops.push(() => ref.set(data));
        },
        update(ref: any, data: any) {
          ops.push(() => ref.update(data));
        },
        delete(ref: any) {
          ops.push(() => ref.delete());
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  };

  return db as Firestore & { store: Map<string, Record<string, any>> };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EventSchema = z.object({
  docId: z.string(),
  residenceId: z.string(),
  title: z.string(),
  documentPath: z.string(),
  createdAt: z.any(),
  updatedAt: z.any(),
});

const PreventionEventSchema = z.object({
  docId: z.string(),
  workshopId: z.string(),
  title: z.string(),
  documentPath: z.string(),
  createdAt: z.any(),
  updatedAt: z.any(),
});

const ResidenceSchema = z.object({
  docId: z.string(),
  name: z.string(),
  documentPath: z.string(),
  createdAt: z.any(),
  updatedAt: z.any(),
});

// ---------------------------------------------------------------------------
// 1. Path template parsing & compile-time typing
// ---------------------------------------------------------------------------

describe("Path Template parsing & compile-time typing", () => {
  test("parsePathTemplate handles root, subcollection, and static transit documents", () => {
    const rootParsed = parsePathTemplate("residences", "docId");
    expect(rootParsed).toEqual({
      rawPath: "residences",
      collectionId: "residences",
      collectionPath: "residences",
      documentPathTemplate: "residences/{docId}",
      parentKeys: [],
      hasTemplate: false,
    });

    const subParsed = parsePathTemplate(
      "residences/{residenceId}/res_events",
      "docId",
    );
    expect(subParsed).toEqual({
      rawPath: "residences/{residenceId}/res_events",
      collectionId: "res_events",
      collectionPath: "residences/{residenceId}/res_events",
      documentPathTemplate: "residences/{residenceId}/res_events/{docId}",
      parentKeys: ["residenceId"],
      hasTemplate: true,
    });

    const transitParsed = parsePathTemplate(
      "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
      "docId",
    );
    expect(transitParsed).toEqual({
      rawPath: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
      collectionId: "prev_events",
      collectionPath:
        "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
      documentPathTemplate:
        "prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}",
      parentKeys: ["workshopId"],
      hasTemplate: true,
    });
  });

  test("extractPathArgsFromDoc ignores static transit document IDs like prev_rules", () => {
    const doc = {
      docId: "ev_123",
      workshopId: "ws_456",
      documentPath:
        "prevention/prev_rules/prev_workshops/ws_456/prev_events/ev_123",
    };

    const args = extractPathArgsFromDoc(doc, {
      pathKey: "documentPath",
      documentKey: "docId",
      parentKeys: ["workshopId"],
      documentPathTemplate:
        "prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}",
      isGroup: true,
    });

    // Must ONLY return ["ws_456", "ev_123"], never ["prev_rules", "ws_456", "ev_123"]
    expect(args).toEqual(["ws_456", "ev_123"]);
  });

  test("compile-time validation rejects invalid {param} in path template", () => {
    createRepositoryConfig(EventSchema)({
      // @ts-expect-error — "unknownParam" is not a key of EventSchema
      path: "residences/{unknownParam}/res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    // Valid template compiles without refCb
    const validConfig = createRepositoryConfig(PreventionEventSchema)({
      path: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["workshopId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    expect(validConfig.path).toBe(
      "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
    );

    const mapping = {
      residences: createRepositoryConfig(ResidenceSchema)({
        path: "residences",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: ["name"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
      }),
      events: createRepositoryConfig(EventSchema)({
        path: "residences/{residenceId}/res_events",
        isGroup: true,
        foreignKeys: ["docId"] as const,
        queryKeys: ["residenceId"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
      }),
      eventsNoTemplate: createRepositoryConfig(EventSchema)({
        path: "res_events",
        isGroup: true,
        foreignKeys: ["docId"] as const,
        queryKeys: ["residenceId"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
      }),
      eventsLegacyRefCb: createRepositoryConfig(EventSchema)({
        path: "res_events",
        isGroup: true,
        foreignKeys: ["docId"] as const,
        queryKeys: ["residenceId"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
        refCb: (db: Firestore, residenceId: string, eventId: string) =>
          db
            .collection("residences")
            .doc(residenceId)
            .collection("res_events")
            .doc(eventId),
      }),
      preventionEvents: validConfig,
    };

    const withRelations = buildRepositoryRelations(mapping, {
      residences: {
        events: {
          repo: "events",
          key: "residenceId",
          type: "many",
          sourceKey: "docId",
        },
        eventsNoTemplate: {
          repo: "eventsNoTemplate",
          key: "residenceId",
          type: "many",
          sourceKey: "docId",
        },
        eventsLegacyRefCb: {
          repo: "eventsLegacyRefCb",
          key: "residenceId",
          type: "many",
          sourceKey: "docId",
        },
      },
      events: {
        residenceId: {
          repo: "residences",
          key: "docId",
          type: "one",
        },
      },
    });
    expect(withRelations.residences.relationalKeys).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Subcollection CRUD (create, set, update, delete) without refCb
// ---------------------------------------------------------------------------

describe("Subcollection CRUD with path templates and create()", () => {
  test("repo.create(data) on subcollection auto-generates docId and extracts parentKeys from data", async () => {
    const db = createInMemoryFirestore();
    const eventConfig = createRepositoryConfig(EventSchema)({
      path: "residences/{residenceId}/res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, eventConfig);

    const created = await repo.create({
      residenceId: "res_1",
      title: "Assemblée Générale",
    });

    expect(typeof created.docId).toBe("string");
    expect(created.docId.length).toBe(20);
    expect(created.residenceId).toBe("res_1");
    expect(created.title).toBe("Assemblée Générale");
    expect(created.documentPath).toBe(
      `residences/res_1/res_events/${created.docId}`,
    );
    expect(created.createdAt).toBeDefined();
    expect(created.updatedAt).toBeDefined();

    // Verify stored in Firestore at the exact subcollection path
    const stored = db.store.get(`residences/res_1/res_events/${created.docId}`);
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("Assemblée Générale");
  });

  test("repo.create(data) on subcollection uses pre-filled docId when provided in data", async () => {
    const db = createInMemoryFirestore();
    const eventConfig = createRepositoryConfig(EventSchema)({
      path: "residences/{residenceId}/res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, eventConfig);

    const created = await repo.create({
      docId: "custom_ev_42",
      residenceId: "res_1",
      title: "Réunion Conseil",
    } as any);

    expect(created.docId).toBe("custom_ev_42");
    expect(created.documentPath).toBe(
      "residences/res_1/res_events/custom_ev_42",
    );
    expect(db.store.has("residences/res_1/res_events/custom_ev_42")).toBe(true);
  });

  test("repo.create(data) on transit-document subcollection resolves static segment automatically", async () => {
    const db = createInMemoryFirestore();
    const prevConfig = createRepositoryConfig(PreventionEventSchema)({
      path: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["workshopId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, prevConfig);

    const created = await repo.create({
      workshopId: "ws_99",
      title: "Atelier Prévention Chutes",
    });

    expect(created.documentPath).toBe(
      `prevention/prev_rules/prev_workshops/ws_99/prev_events/${created.docId}`,
    );

    // Update and delete only take (workshopId, docId) — never "prev_rules"!
    const updated = await repo.update("ws_99", created.docId, {
      title: "Atelier Prévention Chutes v2",
    });
    expect(updated.title).toBe("Atelier Prévention Chutes v2");

    await repo.delete("ws_99", created.docId);
    expect(db.store.has(created.documentPath)).toBe(false);
  });

  test("repo.create(data) throws a clear error when a required parentKey is missing or empty", async () => {
    const db = createInMemoryFirestore();
    const eventConfig = createRepositoryConfig(EventSchema)({
      path: "residences/{residenceId}/res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, eventConfig);

    await expect(
      repo.create({
        residenceId: "",
        title: "Invalid Event",
      }),
    ).rejects.toThrow(/Missing or empty required parent key.*residenceId/);

    await expect(
      repo.create({
        title: "Missing Residence",
      } as any),
    ).rejects.toThrow(/Missing or empty required parent key.*residenceId/);
  });

  test("repo.create(data) works with legacy deprecated refCb as well", async () => {
    const db = createInMemoryFirestore();
    const legacyEventConfig = createRepositoryConfig(EventSchema)({
      path: "res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
      refCb: (firestore: Firestore, residenceId: string, eventId: string) =>
        firestore
          .collection("residences")
          .doc(residenceId)
          .collection("res_events")
          .doc(eventId),
    });

    const repo = createRepository(db, legacyEventConfig);
    const created = await repo.create({
      residenceId: "res_legacy",
      title: "Legacy Event",
    });

    expect(created.documentPath).toBe(
      `residences/res_legacy/res_events/${created.docId}`,
    );
  });

  test("root collection repo.create(data) respects pre-filled docId if non-empty", async () => {
    const db = createInMemoryFirestore();
    const resConfig = createRepositoryConfig(ResidenceSchema)({
      path: "residences",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: ["name"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, resConfig);
    const created = await repo.create({
      docId: "res_custom_id",
      name: "Villa Soleil",
    } as any);

    expect(created.docId).toBe("res_custom_id");
    expect(created.documentPath).toBe("residences/res_custom_id");
  });
});

// ---------------------------------------------------------------------------
// 3. Harmonization of set() on createdKey
// ---------------------------------------------------------------------------

describe("repo.set() createdKey harmonization", () => {
  test("repo.set() initializes createdAt when undefined and preserves it when provided", async () => {
    const db = createInMemoryFirestore();
    const eventConfig = createRepositoryConfig(EventSchema)({
      path: "residences/{residenceId}/res_events",
      isGroup: true,
      foreignKeys: ["docId"] as const,
      queryKeys: ["residenceId"] as const,
      documentKey: "docId",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      pathKey: "documentPath",
    });

    const repo = createRepository(db, eventConfig);

    // 1. Without createdAt -> automatically populated
    const doc1 = await repo.set("res_1", "ev_1", {
      residenceId: "res_1",
      title: "Set without createdAt",
    } as any);
    expect(doc1.createdAt).toBeDefined();
    expect(doc1.updatedAt).toBeDefined();

    // 2. With explicit createdAt -> preserved
    const customCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    const doc2 = await repo.set("res_1", "ev_2", {
      residenceId: "res_1",
      title: "Set with custom createdAt",
      createdAt: customCreatedAt,
    } as any);
    expect(doc2.createdAt).toEqual(customCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// 4. CRUD Server, OpenAPI & Triggers integration with path templates
// ---------------------------------------------------------------------------

describe("CRUD Server, OpenAPI & Triggers with path templates", () => {
  test("CRUD server POST, PATCH, DELETE work seamlessly on transit-document subcollection", async () => {
    const db = createInMemoryFirestore();
    const repos = createRepositoryMapping(() => db, {
      preventionEvents: createRepositoryConfig(PreventionEventSchema)({
        path: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
        isGroup: true,
        foreignKeys: ["docId"] as const,
        queryKeys: ["workshopId"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
      }),
    });

    const registry: any = {
      preventionEvents: {
        name: "preventionEvents",
        path: (repos.preventionEvents as any)._collectionPath,
        repo: repos.preventionEvents,
        schema: PreventionEventSchema,
        documentKey: "docId",
        pathKey: "documentPath",
        isGroup: true,
        parentKeys: (repos.preventionEvents as any)._parentKeys,
        documentPathTemplate: (repos.preventionEvents as any)
          ._documentPathTemplate,
        createdKey: "createdAt",
        systemKeys: ["docId", "documentPath", "createdAt", "updatedAt"],
        queryKeys: ["workshopId"],
        foreignKeys: ["docId"],
        allowDelete: true,
        maxLimit: 100,
        defaultLimit: 25,
      },
    };

    const handlers = createCrudHandlers(registry, "", true);
    const app = new Hono();
    app.post("/:repoName", async (c) => {
      const body = await c.req.json();
      return handlers.handleCreate({ c, input: body });
    });
    app.patch("/:repoName/:id", async (c) => {
      const body = await c.req.json();
      return handlers.handleUpdate({ c, input: body }, true);
    });
    app.delete("/:repoName/:id", async (c) => {
      return handlers.handleDelete({ c });
    });

    // 1. POST /preventionEvents without workshopId -> 400
    const badRes = await app.request("/preventionEvents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No Workshop" }),
    });
    expect(badRes.status).toBe(400);

    // 2. POST /preventionEvents with workshopId -> 201
    const createRes = await app.request("/preventionEvents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workshopId: "ws_100",
        title: "Session Nutrition",
      }),
    });
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as any;
    const createdDoc = createJson.data;
    expect(createdDoc.docId).toBeDefined();
    expect(createdDoc.documentPath).toBe(
      `prevention/prev_rules/prev_workshops/ws_100/prev_events/${createdDoc.docId}`,
    );

    // 3. PATCH /preventionEvents/:id -> 200 (extracts ["ws_100", docId], ignoring "prev_rules")
    const patchRes = await app.request(
      `/preventionEvents/${createdDoc.docId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Session Nutrition Updated" }),
      },
    );
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as any;
    expect(patchJson.data.title).toBe("Session Nutrition Updated");

    // 4. DELETE /preventionEvents/:id -> 200
    const delRes = await app.request(
      `/preventionEvents/${createdDoc.docId}`,
      {
        method: "DELETE",
      },
    );
    expect(delRes.status).toBe(200);
    expect(db.store.has(createdDoc.documentPath)).toBe(false);
  });

  test("OpenAPI spec marks parentKeys as required in Create schema and keeps clean route paths", () => {
    const db = createInMemoryFirestore();
    const repos = createRepositoryMapping(() => db, {
      preventionEvents: createRepositoryConfig(PreventionEventSchema)({
        path: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
        isGroup: true,
        foreignKeys: ["docId"] as const,
        queryKeys: ["workshopId"] as const,
        documentKey: "docId",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        pathKey: "documentPath",
      }),
    });

    const spec = generateOpenAPISpec(
      {
        preventionEvents: {
          name: "preventionEvents",
          path: (repos.preventionEvents as any)._collectionPath,
          repo: repos.preventionEvents as any,
          schema: PreventionEventSchema,
          documentKey: "docId",
          pathKey: "documentPath",
          isGroup: true,
          parentKeys: (repos.preventionEvents as any)._parentKeys,
          documentPathTemplate: (repos.preventionEvents as any)
            ._documentPathTemplate,
          createdKey: "createdAt",
          systemKeys: ["docId", "documentPath", "createdAt", "updatedAt"],
          allowDelete: true,
          pageSize: 25,
        },
      },
      "/",
    );

    // Route paths use repo name, not the Firestore path template
    expect(spec.paths["/preventionEvents"]).toBeDefined();
    expect(
      (spec.components.schemas.PreventionEventCreate as any)?.required,
    ).toContain("workshopId");
  });

  test("History and Sync triggers auto-detect triggerPath from path template on isGroup: true", () => {
    const repos = createRepositoryMapping(
      () => {
        throw new Error("Lazy db must not be called");
      },
      {
        preventionEvents: createRepositoryConfig(PreventionEventSchema)({
          path: "prevention/prev_rules/prev_workshops/{workshopId}/prev_events",
          isGroup: true,
          foreignKeys: ["docId"] as const,
          queryKeys: ["workshopId"] as const,
          documentKey: "docId",
          createdKey: "createdAt",
          updatedKey: "updatedAt",
          pathKey: "documentPath",
          history: { enabled: true },
        }),
      },
    );

    const historyPaths: string[] = [];
    createHistoryTriggers(repos as any, {
      deps: {
        onDocumentWritten: ((path: string, handler: any) => {
          historyPaths.push(path);
          return handler;
        }) as any,
      },
    });
    expect(historyPaths).toEqual([
      "prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}",
    ]);

    const syncPaths: string[] = [];
    createSyncTriggers(repos as any, {
      deps: {
        firestoreTriggers: {
          onDocumentWritten: (path: string, handler: any) => {
            syncPaths.push(path);
            return handler;
          },
        } as any,
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
    });
    expect(syncPaths).toEqual([
      "prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}",
    ]);
  });
});
