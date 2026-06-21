/**
 * Tests for `BaseLogger` and logger injection:
 * - `error()` reuses an error's `errorId` or generates one,
 * - `write` is the single override hook (all levels funnel through it),
 * - the logger is injected into handler + error-handler contexts,
 * - per-API logger overrides the shared one via the registry.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HonoServer } from "../../src/servers/hono/server";
import { createApiRegistry } from "../../src/servers/hono/api-registry";
import { BaseLogger, type LogSeverity } from "../../src/servers/hono/logger";
import type { AnyRouteDef, ErrorHandlerContext } from "../../src/servers/hono/types";

class CaptureLogger extends BaseLogger {
  lines: Array<{ severity: LogSeverity; payload: Record<string, unknown> }> = [];
  protected override write(severity: LogSeverity, payload: Record<string, unknown>) {
    this.lines.push({ severity, payload });
  }
}

describe("BaseLogger", () => {
  test("funnels every level through write()", () => {
    const log = new CaptureLogger();
    log.info("i");
    log.warn("w");
    log.debug("d");
    expect(log.lines.map((l) => l.severity)).toEqual(["INFO", "WARNING", "DEBUG"]);
  });

  test("error() reuses an existing errorId", () => {
    const log = new CaptureLogger();
    const err = Object.assign(new Error("boom"), { errorId: "abc123" });
    const id = log.error(err);
    expect(id).toBe("abc123");
    expect(log.lines[0]!.severity).toBe("ERROR");
    expect(log.lines[0]!.payload.errorId).toBe("abc123");
  });

  test("error() generates an errorId when absent", () => {
    const log = new CaptureLogger();
    const id = log.error(new Error("nope"));
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

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

describe("logger injection", () => {
  test("is injected into the handler ctx", async () => {
    const log = new CaptureLogger();
    const server = new HonoServer({
      routes: [makeRoute((ctx) => {
        ctx.logger.info("from handler");
        return { id: "ok" };
      })],
      openapi,
      logger: log,
    });
    await post(server, { name: "x" });
    expect(log.lines.some((l) => l.payload.message === "from handler")).toBe(true);
  });

  test("is injected into the error-handler ctx", async () => {
    const log = new CaptureLogger();
    const errorHandler = {
      handle({ error, c, logger }: ErrorHandlerContext) {
        logger?.error(error);
        return c.json({ ok: false }, 500);
      },
    };
    const server = new HonoServer({
      routes: [makeRoute(() => {
        throw new Error("explode");
      })],
      openapi,
      logger: log,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errorHandler: errorHandler as any,
    });
    await post(server, { name: "x" });
    expect(log.lines.some((l) => l.severity === "ERROR")).toBe(true);
  });

  test("per-API logger overrides the shared one", async () => {
    const shared = new CaptureLogger();
    const perApi = new CaptureLogger();
    const route = makeRoute((ctx) => {
      ctx.logger.info("hi");
      return { id: "ok" };
    });

    const apis = createApiRegistry(
      {
        v1: { basePath: "/", openapi },
        v2: { basePath: "/", openapi, logger: perApi },
      },
      { logger: shared },
    );

    await post(apis.serverFor("v1", [{ ...route, api: "v1" } as AnyRouteDef]), { name: "x" });
    await post(apis.serverFor("v2", [{ ...route, api: "v2" } as AnyRouteDef]), { name: "x" });

    expect(shared.lines.length).toBe(1); // v1 used shared
    expect(perApi.lines.length).toBe(1); // v2 used its own
  });
});
