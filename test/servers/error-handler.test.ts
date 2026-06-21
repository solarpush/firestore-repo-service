/**
 * Tests for the injectable, auto-applied `ErrorHandler`:
 * - auto-applied on uncaught errors (no interceptor),
 * - injected into handler + interceptor ctx,
 * - `handle() => null` falls through to the built-in envelope / rethrow,
 * - applied when a custom interceptor rethrows,
 * - shared via the registry with per-API override.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HonoServer } from "../../src/servers/hono/server";
import { createApiRegistry } from "../../src/servers/hono/api-registry";
import type { AnyRouteDef, ErrorHandler } from "../../src/servers/hono/types";

class AppError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "AppError";
  }
}

const handler: ErrorHandler = {
  handle({ error, c }) {
    if (error instanceof AppError) {
      return c.json({ error: error.message, handled: true }, error.statusCode);
    }
    return null; // not mine
  },
};

function makeRoute(run: (ctx: any) => unknown): AnyRouteDef {
  return {
    api: "v1",
    method: "post",
    path: "/things",
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    handler: run,
  } as unknown as AnyRouteDef;
}

const openapi = { info: { title: "T", version: "1.0.0" } };

function post(server: HonoServer, body: unknown) {
  return server.hono.fetch(
    new Request("http://localhost/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("ErrorHandler auto-application", () => {
  test("maps a thrown AppError to its status + body (no interceptor)", async () => {
    const server = new HonoServer({
      routes: [makeRoute(() => {
        throw new AppError("nope", 404);
      })],
      openapi,
      errorHandler: handler,
    });
    const res = await post(server, { name: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nope", handled: true });
  });

  test("handle() => null falls through to the built-in ValidationError envelope", async () => {
    const server = new HonoServer({
      routes: [makeRoute(() => ({ id: "ok" }))],
      openapi,
      errorHandler: handler,
    });
    // invalid body → ValidationError, which AppError handler declines (null)
    const res = await post(server, { name: 123 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  test("is injected into the handler ctx", async () => {
    let injected: unknown = "missing";
    const server = new HonoServer({
      routes: [makeRoute((ctx) => {
        injected = ctx.errorHandler;
        return { id: "ok" };
      })],
      openapi,
      errorHandler: handler,
    });
    await post(server, { name: "x" });
    expect(injected).toBe(handler);
  });

  test("applies when a custom interceptor rethrows", async () => {
    const server = new HonoServer({
      routes: [makeRoute(() => {
        throw new AppError("boom", 409);
      })],
      openapi,
      errorHandler: handler,
      interceptor: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async ({ next, c }: any) => c.json({ data: await next() }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const res = await post(server, { name: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "boom", handled: true });
  });

  test("interceptor can use the injected errorHandler manually", async () => {
    let seen: unknown = "missing";
    const server = new HonoServer({
      routes: [makeRoute(() => ({ id: "ok" }))],
      openapi,
      errorHandler: handler,
      interceptor: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async ({ next, c, errorHandler }: any) => {
          seen = errorHandler;
          return c.json({ data: await next() });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    await post(server, { name: "x" });
    expect(seen).toBe(handler);
  });
});

describe("ErrorHandler via registry", () => {
  test("shared errorHandler is applied; per-API config overrides it", async () => {
    const shared: ErrorHandler = {
      handle: ({ error, c }) =>
        error instanceof AppError ? c.json({ via: "shared" }, error.statusCode) : null,
    };
    const perApi: ErrorHandler = {
      handle: ({ error, c }) =>
        error instanceof AppError ? c.json({ via: "v2" }, error.statusCode) : null,
    };

    const route = makeRoute(() => {
      throw new AppError("e", 418);
    });

    const apis = createApiRegistry(
      {
        v1: { basePath: "/", openapi },
        v2: { basePath: "/", openapi, errorHandler: perApi },
      },
      { errorHandler: shared },
    );

    const v1 = apis.serverFor("v1", [{ ...route, api: "v1" } as AnyRouteDef]);
    const v2 = apis.serverFor("v2", [{ ...route, api: "v2" } as AnyRouteDef]);

    expect(await (await post(v1, { name: "x" })).json()).toEqual({ via: "shared" });
    expect(await (await post(v2, { name: "x" })).json()).toEqual({ via: "v2" });
  });
});
