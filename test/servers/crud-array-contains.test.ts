import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Hono } from "hono";
import {
  parseFilters,
  parseFieldValue,
  normalizeWhereOp,
  createCrudHandlers,
} from "../../src/servers/crud/handlers";
import { generateOpenAPISpec } from "../../src/servers/crud/openapi";

describe("CRUD server - array-contains and array-contains-any filters", () => {
  const schema = z.object({
    id: z.string(),
    title: z.string(),
    tags: z.array(z.string()),
    scores: z.array(z.number()),
    user: z.object({
      roles: z.array(z.string()),
    }),
  });

  describe("parseFilters", () => {
    test("parses contains and array-contains aliases", () => {
      const filters = parseFilters(
        {
          tags__contains: "news",
          scores__contains: "42",
        },
        undefined,
      );

      expect(filters).toEqual([
        { field: "tags", op: "array-contains", value: "news" },
        { field: "scores", op: "array-contains", value: 42 },
      ]);
    });

    test("parses array-contains with hyphen and underscore variants", () => {
      const filters = parseFilters(
        {
          "tags__array-contains": "tech",
          tags__array_contains: "ai",
          tags__arrayContains: "web",
        },
        undefined,
      );

      expect(filters).toEqual([
        { field: "tags", op: "array-contains", value: "tech" },
        { field: "tags", op: "array-contains", value: "ai" },
        { field: "tags", op: "array-contains", value: "web" },
      ]);
    });

    test("parses containsAny and array-contains-any aliases as comma-separated list", () => {
      const filters = parseFilters(
        {
          tags__containsAny: "news,tech",
          scores__containsAny: "1,2,3",
        },
        undefined,
      );

      expect(filters).toEqual([
        { field: "tags", op: "array-contains-any", value: ["news", "tech"] },
        { field: "scores", op: "array-contains-any", value: [1, 2, 3] },
      ]);
    });

    test("parses dot-notation field paths with contains", () => {
      const filters = parseFilters(
        {
          "user.roles__contains": "admin",
        },
        undefined,
      );

      expect(filters).toEqual([
        { field: "user.roles", op: "array-contains", value: "admin" },
      ]);
    });
  });

  describe("parseFieldValue", () => {
    test("validates element against element schema for array-contains", () => {
      const result = parseFieldValue(schema, "tags", "news", "array-contains");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("news");
      }
    });

    test("validates element against element schema for contains alias", () => {
      const result = parseFieldValue(schema, "tags", "news", "contains");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("news");
      }
    });

    test("validates number element for array-contains on number array", () => {
      const valid = parseFieldValue(schema, "scores", 42, "array-contains");
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data).toBe(42);
      }

      const invalid = parseFieldValue(schema, "scores", "not-a-number", "array-contains");
      expect(invalid.success).toBe(false);
    });

    test("validates elements for array-contains-any", () => {
      const result = parseFieldValue(
        schema,
        "tags",
        ["news", "tech"],
        "array-contains-any",
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(["news", "tech"]);
      }
    });

    test("validates elements for containsAny alias", () => {
      const result = parseFieldValue(
        schema,
        "scores",
        [10, 20],
        "containsAny",
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([10, 20]);
      }
    });

    test("validates dot-notation nested array field for array-contains", () => {
      const result = parseFieldValue(
        schema,
        "user.roles",
        "admin",
        "array-contains",
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("admin");
      }
    });
  });

  describe("CRUD routes integration", () => {
    let capturedOptions: any = null;

    const fakeRepo = {
      query: {
        paginate: async (opts: any) => {
          capturedOptions = opts;
          return { data: [], cursor: null, hasMore: false };
        },
      },
    };

    const registry = {
      articles: {
        name: "articles",
        path: "articles",
        repo: fakeRepo as any,
        systemKeys: [],
        documentKey: "id",
        isGroup: false,
        pageSize: 25,
        filterableFields: ["tags", "scores", "user.roles"],
        schema,
      },
    };

    const handlers = createCrudHandlers(registry, "/api", true);
    const app = new Hono();
    app.get("/api/articles", (c) => handlers.handleList({ c, user: null, params: {}, body: {} }));
    app.post("/api/articles/query", async (c) => {
      const body = await c.req.json();
      return handlers.handleQuery({ c, user: null, params: {}, input: body, body });
    });

    test("GET /api/articles?tags__contains=news executes with array-contains where clause", async () => {
      capturedOptions = null;
      const res = await app.request("/api/articles?tags__contains=news");
      expect(res.status).toBe(200);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.where).toEqual([["tags", "array-contains", "news"]]);
    });

    test("GET /api/articles?tags__containsAny=news,tech executes with array-contains-any where clause", async () => {
      capturedOptions = null;
      const res = await app.request("/api/articles?tags__containsAny=news,tech");
      expect(res.status).toBe(200);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.where).toEqual([
        ["tags", "array-contains-any", ["news", "tech"]],
      ]);
    });

    test("POST /api/articles/query with 'array-contains' executes properly", async () => {
      capturedOptions = null;
      const res = await app.request("/api/articles/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          where: [["tags", "array-contains", "news"]],
        }),
      });
      expect(res.status).toBe(200);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.where).toEqual([["tags", "array-contains", "news"]]);
    });

    test("POST /api/articles/query with 'contains' alias executes properly", async () => {
      capturedOptions = null;
      const res = await app.request("/api/articles/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          where: [["tags", "contains", "news"]],
        }),
      });
      expect(res.status).toBe(200);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.where).toEqual([["tags", "array-contains", "news"]]);
    });

    test("POST /api/articles/query with 'containsAny' alias executes properly", async () => {
      capturedOptions = null;
      const res = await app.request("/api/articles/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          where: [["tags", "containsAny", ["news", "tech"]]],
        }),
      });
      expect(res.status).toBe(200);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.where).toEqual([
        ["tags", "array-contains-any", ["news", "tech"]],
      ]);
    });
  });

  describe("OpenAPI spec generation", () => {
    test("OpenAPI spec generates string elemSchema for array field where tuples", () => {
      const registry = {
        articles: {
          name: "articles",
          path: "articles",
          repo: {} as any,
          systemKeys: [],
          documentKey: "id",
          isGroup: false,
          pageSize: 25,
          schema,
        },
      };

      const spec = generateOpenAPISpec(registry, "/api");
      const requestBodySchema = spec.components.schemas["ArticleQueryRequestBody"] as any;
      expect(requestBodySchema).toBeDefined();

      const whereItems = requestBodySchema.properties.where.items.oneOf as any[];
      const tagsContainsTuple = whereItems.find(
        (tuple) =>
          tuple.prefixItems[0].enum[0] === "tags" &&
          tuple.prefixItems[1].enum.includes("array-contains"),
      );
      expect(tagsContainsTuple).toBeDefined();
      expect(tagsContainsTuple.prefixItems[2].type).toBe("string");
    });
  });
});
