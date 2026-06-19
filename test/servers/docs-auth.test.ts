/**
 * Integration tests for OpenAPI docs auth — `OpenAPIConfig.docsAuth` guards
 * only the `/docs` + `/openapi.json` endpoints (never the API routes), and the
 * built-in `firebaseBearerAuth` / `basicAuth` helpers behave as expected.
 */

import { describe, expect, test } from "bun:test";
import { HonoServer } from "../../src/servers/hono/server";
import {
  basicAuth,
  firebaseBearerAuth,
} from "../../src/servers/hono/docs-auth";

const baseOpenApi = {
  info: { title: "Test API", version: "1.0.0" },
};

function fetchPath(server: HonoServer, path: string, headers?: Record<string, string>) {
  return server.hono.fetch(
    new Request(`http://localhost${path}`, { headers }),
  );
}

describe("docsAuth guards", () => {
  test("without docsAuth, docs + spec are public", async () => {
    const server = new HonoServer({ routes: [], openapi: { ...baseOpenApi } });

    expect((await fetchPath(server, "/openapi.json")).status).toBe(200);
    expect((await fetchPath(server, "/docs")).status).toBe(200);
  });

  test("a custom middleware guards docs + spec but not other paths", async () => {
    const guard = async (c: any, next: any) => {
      if (c.req.header("x-token") !== "secret") return c.text("nope", 401);
      return next();
    };
    const server = new HonoServer({
      routes: [],
      openapi: { ...baseOpenApi, docsAuth: guard },
    });

    expect((await fetchPath(server, "/openapi.json")).status).toBe(401);
    expect((await fetchPath(server, "/docs")).status).toBe(401);

    const okHeaders = { "x-token": "secret" };
    expect((await fetchPath(server, "/openapi.json", okHeaders)).status).toBe(200);
    expect((await fetchPath(server, "/docs", okHeaders)).status).toBe(200);

    // An unrelated path is untouched by the docs guard (404, not 401).
    expect((await fetchPath(server, "/nope")).status).toBe(404);
  });

  test("an array of middlewares is applied in order", async () => {
    const calls: string[] = [];
    const a = async (_c: any, next: any) => {
      calls.push("a");
      return next();
    };
    const b = async (c: any, next: any) => {
      calls.push("b");
      if (c.req.header("x-ok") !== "1") return c.text("no", 401);
      return next();
    };
    const server = new HonoServer({
      routes: [],
      openapi: { ...baseOpenApi, docsAuth: [a, b] },
    });

    expect((await fetchPath(server, "/openapi.json")).status).toBe(401);
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("firebaseBearerAuth helper", () => {
  const fakeAuth = (validToken: string, claims: Record<string, unknown> = {}) => ({
    verifyIdToken: async (token: string) => {
      if (token !== validToken) throw new Error("invalid");
      return { uid: "u1", ...claims };
    },
  });

  function serverWith(opts: Parameters<typeof firebaseBearerAuth>[0]) {
    return new HonoServer({
      routes: [],
      openapi: { ...baseOpenApi, docsAuth: firebaseBearerAuth(opts) },
    });
  }

  test("401 when the Bearer header is missing or malformed", async () => {
    const server = serverWith({ getAuth: () => fakeAuth("good") });

    const res = await fetchPath(server, "/openapi.json");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");

    expect(
      (await fetchPath(server, "/openapi.json", { authorization: "Basic x" }))
        .status,
    ).toBe(401);
  });

  test("401 on an invalid token, 200 on a valid one", async () => {
    const server = serverWith({ getAuth: () => fakeAuth("good") });

    expect(
      (await fetchPath(server, "/openapi.json", { authorization: "Bearer bad" }))
        .status,
    ).toBe(401);
    expect(
      (await fetchPath(server, "/openapi.json", { authorization: "Bearer good" }))
        .status,
    ).toBe(200);
  });

  test("403 when allow() rejects the verified token", async () => {
    const server = serverWith({
      getAuth: () => fakeAuth("good", { admin: false }),
      allow: (t) => t.admin === true,
    });

    expect(
      (await fetchPath(server, "/openapi.json", { authorization: "Bearer good" }))
        .status,
    ).toBe(403);
  });
});

describe("basicAuth helper", () => {
  function serverWith() {
    return new HonoServer({
      routes: [],
      openapi: {
        ...baseOpenApi,
        docsAuth: basicAuth({ username: "admin", password: "secret" }),
      },
    });
  }

  test("401 with WWW-Authenticate when credentials are absent/wrong", async () => {
    const server = serverWith();

    const res = await fetchPath(server, "/openapi.json");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Docs"');

    const wrong = { authorization: `Basic ${btoa("admin:nope")}` };
    expect((await fetchPath(server, "/openapi.json", wrong)).status).toBe(401);
  });

  test("200 with correct credentials", async () => {
    const server = serverWith();
    const ok = { authorization: `Basic ${btoa("admin:secret")}` };
    expect((await fetchPath(server, "/openapi.json", ok)).status).toBe(200);
  });
});
