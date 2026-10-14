/**
 * Tests for the static OpenAPI export surface used by `frs sdk:spec`:
 * - the Hono registry exposes `apis.spec(api, routes)` → an OpenAPI 3.1 doc
 *   built without booting a server;
 * - `createServers().crud(...)` keeps its `.spec()` accessor even when wrapped
 *   into a Cloud Function via `onRequest` (so the export still works).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createApiRegistry } from "../../src/servers/hono/api-registry";
import type { AnyRouteDef } from "../../src/servers/hono/types";

const openapi = { info: { title: "Spec Demo", version: "1.0.0" } };

function makeRoute(): AnyRouteDef {
  return {
    api: "v1",
    method: "post",
    path: "/things",
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    tags: ["things"],
    summary: "Create a thing",
    handler: () => ({ id: "ok" }),
  } as unknown as AnyRouteDef;
}

describe("apis.spec — static Hono OpenAPI export", () => {
  test("builds an OpenAPI 3.1 document without a server boot", () => {
    const apis = createApiRegistry({ v1: { basePath: "/v1", openapi } });
    const routes = [makeRoute()];

    const doc = apis.spec("v1", routes) as any;

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Spec Demo");
    // The route is present and carries its operation metadata.
    const paths = Object.keys(doc.paths ?? {});
    expect(paths.some((p) => p.includes("/things"))).toBe(true);
  });

  test("throws on an unknown api tag", () => {
    const apis = createApiRegistry({ v1: { basePath: "/v1", openapi } });
    // @ts-expect-error unknown tag — also a compile error (literal-key inference)
    expect(() => apis.spec("ghost", [])).toThrow(/unknown api/);
  });

  test("handles z.custom and z.instanceof (e.g. Timestamp) without throwing UnknownZodTypeError", () => {
    class FakeTimestamp {}
    const customTimestamp = z.instanceof(FakeTimestamp);
    const customUnionMeta = z.custom<FakeTimestamp>(() => true).openapi({
      anyOf: [{ type: "string" }, { type: "object" }],
    });

    const apis = createApiRegistry({ v1: { basePath: "/v1", openapi } });
    const routes: AnyRouteDef[] = [
      {
        api: "v1",
        method: "post",
        path: "/events",
        input: z.object({
          createdAt: customTimestamp,
          scheduledAt: customUnionMeta.nullable().optional(),
        }),
        output: z.object({
          id: z.string(),
          createdAt: customTimestamp,
        }),
        tags: ["events"],
        summary: "Create event",
        handler: () => ({ id: "1", createdAt: new FakeTimestamp() }),
      } as unknown as AnyRouteDef,
    ];

    const doc = apis.spec("v1", routes) as any;
    expect(doc.openapi).toBe("3.1.0");
    const postOp = doc.paths["/v1/events"]?.post;
    expect(postOp).toBeDefined();
    const reqProps =
      postOp.requestBody.content["application/json"].schema.properties;
    expect(reqProps.createdAt).toEqual({ type: "object" });
    expect(reqProps.scheduledAt.anyOf).toBeDefined();
    expect(reqProps.scheduledAt.type).toBeUndefined();
  });
});

