/**
 * Tests for `firebaseDocsAuth` — the login-form (session cookie) guard for the
 * OpenAPI docs/spec endpoints:
 * - exposes a DocsAuthExtension (guard middleware + login/session/logout routes),
 * - serves the login page (unguarded) and exchanges an id token for a cookie,
 * - redirects unauthenticated browsers, 401s API clients, allows valid cookies,
 * - honours `allow`, `mode: "both"` (Bearer), and logout.
 */

import { describe, expect, test } from "bun:test";
import { HonoServer } from "../../src/servers/hono/server";
import {
  firebaseDocsAuth,
  isDocsAuthExtension,
} from "../../src/servers/hono/docs-auth";
import type { FirebaseAdminAuthLike } from "../../src/servers/auth/firebase-auth";

const openapi = { info: { title: "Docs Demo", version: "1.0.0" } };

/** Mock Firebase Admin Auth — records calls, returns canned decoded tokens. */
function mockAuth(
  overrides: Partial<FirebaseAdminAuthLike> = {},
): FirebaseAdminAuthLike {
  return {
    verifyIdToken: async () => ({
      uid: "u1",
      email: "a@b.c",
      auth_time: Math.floor(Date.now() / 1000),
    }),
    verifySessionCookie: async () => ({ uid: "u1", email: "a@b.c" }),
    createSessionCookie: async () => "session-cookie-value",
    revokeRefreshTokens: async () => {},
    ...overrides,
  };
}

function makeServer(ext: ReturnType<typeof firebaseDocsAuth>) {
  return new HonoServer({
    routes: [],
    openapi: { ...openapi, docsAuth: ext },
  });
}

function get(
  server: HonoServer,
  path: string,
  headers: Record<string, string> = {},
) {
  return server.hono.fetch(
    new Request(`http://localhost${path}`, { method: "GET", headers }),
  );
}
function post(
  server: HonoServer,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return server.hono.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const baseOpts = {
  apiKey: "test-key",
  authDomain: "demo.firebaseapp.com",
  secureCookie: false,
};

describe("firebaseDocsAuth — shape", () => {
  test("returns a DocsAuthExtension with login/session/logout routes", () => {
    const ext = firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts });
    expect(isDocsAuthExtension(ext)).toBe(true);
    expect(ext.loginName).toBe("__login");
    expect(ext.routes.map((r) => `${r.method} ${r.name}`)).toEqual([
      "GET __login",
      "POST __session",
      "POST __logout",
    ]);
  });

  test("throws when apiKey / authDomain are missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing required fields
      firebaseDocsAuth({ getAuth: () => mockAuth() }),
    ).toThrow(/apiKey.*authDomain/);
  });
});

describe("firebaseDocsAuth — login page (unguarded)", () => {
  test("GET __login serves the login form", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await get(server, "/__login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Docs sign-in");
    expect(html).toContain("firebasejs"); // bundled JS SDK
  });

  test("wires the Auth emulator when authEmulatorHost is set", async () => {
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () => mockAuth(),
        ...baseOpts,
        authEmulatorHost: "127.0.0.1:9099",
      }),
    );
    const html = await (await get(server, "/__login")).text();
    expect(html).toContain(
      'connectAuthEmulator(auth, "http://127.0.0.1:9099"',
    );
  });

  test("omits the emulator wiring by default", async () => {
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () => mockAuth(),
        ...baseOpts,
        authEmulatorHost: "",
      }),
    );
    const html = await (await get(server, "/__login")).text();
    expect(html).not.toContain("connectAuthEmulator(auth");
  });
});

describe("firebaseDocsAuth — guard", () => {
  test("redirects an unauthenticated browser GET to the login page", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await get(server, "/docs", { accept: "text/html" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("__login?next=docs");
  });

  test("401s an unauthenticated API client (no html accept)", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await get(server, "/openapi.json", {
      accept: "application/json",
    });
    expect(res.status).toBe(401);
  });

  test("allows a request carrying a valid session cookie", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await get(server, "/docs", {
      accept: "text/html",
      cookie: "__docs_session=session-cookie-value",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Docs Demo");
  });

  test("rejects a cookie whose user fails the allow() policy", async () => {
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () => mockAuth(),
        allow: () => false,
        ...baseOpts,
      }),
    );
    const res = await get(server, "/openapi.json", {
      accept: "application/json",
      cookie: "__docs_session=session-cookie-value",
    });
    expect(res.status).toBe(401);
  });

  test("mode 'both' accepts a valid Bearer token", async () => {
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () => mockAuth(),
        mode: "both",
        ...baseOpts,
      }),
    );
    const res = await get(server, "/openapi.json", {
      accept: "application/json",
      authorization: "Bearer good-token",
    });
    expect(res.status).toBe(200);
  });
});

describe("firebaseDocsAuth — session exchange", () => {
  test("POST __session mints a cookie from a valid id token", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await post(server, "/__session", { idToken: "valid" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__docs_session=");
    expect(setCookie).toContain("HttpOnly");
  });

  test("POST __session 400s when idToken is missing", async () => {
    const server = makeServer(
      firebaseDocsAuth({ getAuth: () => mockAuth(), ...baseOpts }),
    );
    const res = await post(server, "/__session", {});
    expect(res.status).toBe(400);
  });

  test("POST __session 401s a stale sign-in", async () => {
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () =>
          mockAuth({
            verifyIdToken: async () => ({
              uid: "u1",
              auth_time: Math.floor(Date.now() / 1000) - 3600, // 1h ago
            }),
          }),
        ...baseOpts,
      }),
    );
    const res = await post(server, "/__session", { idToken: "old" });
    expect(res.status).toBe(401);
  });
});

describe("firebaseDocsAuth — logout", () => {
  test("POST __logout clears the cookie and revokes tokens", async () => {
    let revoked = "";
    const server = makeServer(
      firebaseDocsAuth({
        getAuth: () =>
          mockAuth({
            revokeRefreshTokens: async (uid: string) => {
              revoked = uid;
            },
          }),
        ...baseOpts,
      }),
    );
    const res = await post(
      server,
      "/__logout",
      {},
      { cookie: "__docs_session=session-cookie-value" },
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    expect(revoked).toBe("u1");
  });
});
