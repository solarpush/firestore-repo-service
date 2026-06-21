/**
 * Tests for the package's `BaseErrorHandler`:
 * - used as-is, it maps the built-in errors (ValidationError → 400),
 * - extended, `mapError` handles domain errors and `super` covers the rest,
 * - `logError` runs only when `mapError` produced a response.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HonoServer } from "../../src/servers/hono/server";
import { BaseErrorHandler } from "../../src/servers/hono/error-handler";
import type {
  AnyRouteDef,
  ErrorHandlerContext,
} from "../../src/servers/hono/types";

class AppError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "AppError";
  }
}

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

describe("BaseErrorHandler (as-is)", () => {
  test("maps the built-in ValidationError to a 400 envelope", async () => {
    const server = new HonoServer({
      routes: [makeRoute(() => ({ id: "ok" }))],
      openapi,
      errorHandler: new BaseErrorHandler(),
    });
    const res = await post(server, { name: 123 }); // invalid → ValidationError
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });

  test("returns null for unknown errors (bubbles up)", async () => {
    const server = new HonoServer({
      routes: [makeRoute(() => {
        throw new Error("boom");
      })],
      openapi,
      errorHandler: new BaseErrorHandler(),
      onError: (_e, c) => c.json({ caught: "onError" }, 500),
    });
    const res = await post(server, { name: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ caught: "onError" });
  });
});

describe("BaseErrorHandler (extended)", () => {
  let logged: unknown = null;

  class AppErrorHandler extends BaseErrorHandler {
    protected override mapError({ error, c }: ErrorHandlerContext): Response | null {
      if (error instanceof AppError) {
        return c.json({ error: error.message, mapped: true }, error.statusCode as any);
      }
      return null; // → built-in via super
    }
    protected override logError({ error }: ErrorHandlerContext): void {
      logged = error;
    }
  }

  test("mapError handles the domain error + logError runs", async () => {
    logged = null;
    const server = new HonoServer({
      routes: [makeRoute(() => {
        throw new AppError("nope", 404);
      })],
      openapi,
      errorHandler: new AppErrorHandler(),
    });
    const res = await post(server, { name: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nope", mapped: true });
    expect(logged).toBeInstanceOf(AppError);
  });

  test("unmapped errors fall back to super (built-in), without logError", async () => {
    logged = null;
    const server = new HonoServer({
      routes: [makeRoute(() => ({ id: "ok" }))],
      openapi,
      errorHandler: new AppErrorHandler(),
    });
    const res = await post(server, { name: 123 }); // ValidationError → super
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(logged).toBeNull(); // logError only runs for mapped errors
  });
});
