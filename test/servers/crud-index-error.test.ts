import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { createCrudServer, type IndexErrorContext } from "../../src/servers/crud";
import { createCrudHandlers } from "../../src/servers/crud/handlers";
import { generateOpenAPISpec } from "../../src/servers/crud/openapi";

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  score: z.number(),
});

describe("CRUD Missing Index detection & indexesError callback", () => {
  test("invokes indexesError callback and returns 424 with indexUrl on list/query missing-index error", async () => {
    let capturedIndexCtx: IndexErrorContext | null = null;

    const fakeRepo = {
      ref: {
        firestore: {
          projectId: "my-test-gcp-project",
        },
      },
      query: {
        paginate: async () => {
          const err = new Error(
            "The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/my-test-gcp-project/firestore/indexes?create_composite=ClZwcm9qZWN0cw",
          );
          (err as any).code = 9;
          throw err;
        },
      },
    };

    const registry: any = {
      items: {
        name: "items",
        path: "items",
        repo: fakeRepo,
        schema: itemSchema,
        systemKeys: ["id"],
        documentKey: "id",
        pageSize: 25,
        filterableFields: ["category", "score"],
        allowDelete: false,
      },
    };

    const handlers = createCrudHandlers(
      registry,
      "",
      false,
      async (ctx) => {
        capturedIndexCtx = ctx;
      },
    );

    const app = new Hono();
    app.get("/items", (c) => handlers.handleList({ c, input: {} }));

    const res = await app.request("/items?category=books&score=10");

    expect(res.status).toBe(424);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorType).toBe("index");
    expect(body.indexUrl).toContain("console.firebase.google.com");

    expect(capturedIndexCtx).not.toBeNull();
    expect(capturedIndexCtx?.repoName).toBe("items");
    expect(capturedIndexCtx?.path).toBe("items");
    expect(capturedIndexCtx?.indexUrl).toContain("console.firebase.google.com");
    expect(capturedIndexCtx?.filters.length).toBe(2);
  });

  test("returns 500 JSON on unexpected query error and doesn't leave context unfinalized", async () => {
    const fakeRepo = {
      ref: {},
      query: {
        paginate: async () => {
          throw new Error("Unexpected database connection crash");
        },
      },
    };

    const registry: any = {
      items: {
        name: "items",
        path: "items",
        repo: fakeRepo,
        schema: itemSchema,
        systemKeys: ["id"],
        documentKey: "id",
        pageSize: 25,
        allowDelete: false,
      },
    };

    const handlers = createCrudHandlers(registry, "", true);
    const app = new Hono();
    app.get("/items", (c) => handlers.handleList({ c, input: {} }));

    const res = await app.request("/items");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Unexpected database connection crash");
  });

  test("generateOpenAPISpec documents 424 and ErrorResponse with indexUrl", () => {
    const fakeRepo = {
      ref: {},
      query: {},
    };

    const registry: any = {
      items: {
        name: "items",
        path: "items",
        repo: fakeRepo,
        schema: itemSchema,
        systemKeys: ["id"],
        documentKey: "id",
        pageSize: 25,
        allowDelete: false,
      },
    };

    const spec = generateOpenAPISpec(registry, "");
    expect(spec.components.schemas["ErrorResponse"]).toBeDefined();
    expect(spec.components.schemas["ErrorResponse"].properties.errorType).toBeDefined();
    expect(spec.components.schemas["ErrorResponse"].properties.indexUrl).toBeDefined();

    expect(spec.paths["/items/query"].post.responses["424"]).toBeDefined();
    expect(spec.paths["/items/{id}"].get.responses["424"]).toBeDefined();
  });
});
