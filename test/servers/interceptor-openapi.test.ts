/**
 * Tests for the structured interceptor (`{ output, errors, handler }`):
 * - the OpenAPI spec documents the wrapped envelope (static + factory `output`),
 * - declared `errors` appear on every operation,
 * - both interceptor forms (object + bare function) still run at runtime.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HonoServer } from "../../src/servers/hono/server";
import type { AnyRouteDef } from "../../src/servers/hono/types";

const okOutput = z.object({ id: z.string() });

const route: AnyRouteDef = {
  api: "v1",
  method: "post",
  path: "/things",
  input: z.object({ name: z.string() }),
  output: okOutput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async ({ input }: any) => ({ id: input.name }),
} as unknown as AnyRouteDef;

const baseOpenApi = { info: { title: "T", version: "1.0.0" } };

function specFor(interceptor: unknown) {
  const server = new HonoServer({
    routes: [route],
    openapi: baseOpenApi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interceptor: interceptor as any,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server.buildOpenApiSpec() as any;
}

function postThings(spec: any) {
  return spec.paths["/things"].post;
}

describe("interceptor OpenAPI envelope", () => {
  test("without interceptor, the 200 schema is the raw route.output", () => {
    const spec = specFor(undefined);
    const schema = postThings(spec).responses["200"].content["application/json"].schema;
    // raw output → object with only `id`
    expect(Object.keys(schema.properties)).toEqual(["id"]);
  });

  test("static output schema wraps every route the same way", () => {
    const spec = specFor({
      output: z.object({ data: z.any(), intercepted: z.boolean() }),
      handler: async ({ next }: any) => next(),
    });
    const schema = postThings(spec).responses["200"].content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["data", "intercepted"]);
  });

  test("factory output wraps each route's own output (data = route schema)", () => {
    const spec = specFor({
      output: (routeOutput: z.ZodTypeAny | undefined) =>
        z.object({ data: routeOutput ?? z.unknown(), intercepted: z.boolean() }),
      handler: async ({ next }: any) => next(),
    });
    const schema = postThings(spec).responses["200"].content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["data", "intercepted"]);
    // `data` is the route's own output → object with `id`
    expect(Object.keys(schema.properties.data.properties)).toEqual(["id"]);
  });

  test("declared errors appear on the operation", () => {
    const spec = specFor({
      output: z.object({ data: z.any() }),
      errors: {
        400: z.object({ success: z.literal(false), error: z.string() }),
        500: { description: "Boom", schema: z.object({ error: z.string() }) },
      },
      handler: async ({ next }: any) => next(),
    });
    const op = postThings(spec);
    expect(op.responses["400"]).toBeDefined();
    expect(op.responses["400"].content["application/json"].schema).toBeDefined();
    expect(op.responses["500"].description).toBe("Boom");
  });
});

describe("interceptor runtime (both forms)", () => {
  function fetchJson(server: HonoServer, body: unknown) {
    return server.hono.fetch(
      new Request("http://localhost/things", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("object form: handler still wraps the response", async () => {
    const server = new HonoServer({
      routes: [route],
      openapi: baseOpenApi,
      interceptor: {
        output: z.object({ data: z.any(), intercepted: z.boolean() }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async ({ c, next }: any) => c.json({ data: await next(), intercepted: true }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const res = await fetchJson(server, { name: "abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "abc" }, intercepted: true });
  });

  test("bare function form still works (backward compatible)", async () => {
    const server = new HonoServer({
      routes: [route],
      openapi: baseOpenApi,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interceptor: (async ({ c, next }: any) =>
        c.json({ wrapped: await next() })) as any,
    });
    const res = await fetchJson(server, { name: "xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrapped: { id: "xyz" } });
  });
});
