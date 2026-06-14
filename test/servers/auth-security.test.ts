/**
 * Regression tests for the auth-layer security fixes:
 *  #05 CSRF same-origin check on cookie-session mutations
 *  #06 `?__action=logout` is protected by the same-origin check
 *  #07 open-redirect sanitisation of the post-login `next` target
 *  #16 unauthenticated API requests get 401 (not a 200 HTML login page)
 */

import { describe, test, expect } from "bun:test";
import { firebaseAuth } from "../../src/servers/auth/firebase-auth";

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

const failingAuth = {
  getAuth: () => ({
    verifyIdToken: async () => {
      throw new Error("invalid");
    },
    verifySessionCookie: async () => {
      throw new Error("invalid");
    },
    createSessionCookie: async () => "cookie",
    revokeRefreshTokens: async () => {},
  }),
  apiKey: "test-key",
  authDomain: "test.firebaseapp.com",
};

describe("#16 unauthenticated requests are HTTP-compliant", () => {
  test("API client (Accept: */*) gets 401 JSON, not 200 HTML", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie" });
    const req: any = {
      method: "GET",
      url: "/users",
      headers: { accept: "*/*", host: "admin.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["content-type"])).toContain("application/json");
  });

  test("browser (Accept: text/html) gets the login page with a 401 status", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie" });
    const req: any = {
      method: "GET",
      url: "/users",
      headers: { accept: "text/html", host: "admin.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["content-type"])).toContain("text/html");
  });
});

describe("#05/#06 CSRF same-origin guard on cookie mutations", () => {
  test("default Lax cookie does NOT run the Origin check (relies on SameSite)", async () => {
    // Reproduces the admin edit-form regression: a same-origin POST on
    // Cloud Functions where Host != Origin must not be rejected.
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie" });
    const req: any = {
      method: "POST",
      url: "/posts/abc/edit",
      query: {},
      headers: {
        origin: "https://us-central1-proj.cloudfunctions.net",
        host: "admin-xxxx-uc.a.run.app", // internal Cloud Run host differs
      },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    expect(res.statusCode).not.toBe(403);
  });

  test("cross-origin POST ?__action=logout is rejected with 403 (SameSite=None)", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie", sameSite: "None" });
    const req: any = {
      method: "POST",
      url: "/anything?__action=logout",
      query: { __action: "logout" },
      headers: { origin: "https://evil.com", host: "admin.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    expect(res.statusCode).toBe(403);
  });

  test("same-origin POST ?__action=logout is allowed through (SameSite=None)", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie", sameSite: "None" });
    const req: any = {
      method: "POST",
      url: "/anything?__action=logout",
      query: { __action: "logout" },
      headers: { origin: "https://admin.example", host: "admin.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    // Logout handler runs (clears cookie) → not a 403.
    expect(res.statusCode).not.toBe(403);
  });

  test("csrfProtection:true forces the check even with Lax", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie", csrfProtection: true });
    const req: any = {
      method: "POST",
      url: "/posts/abc/edit",
      query: {},
      headers: { origin: "https://evil.com", host: "admin.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    expect(res.statusCode).toBe(403);
  });

  test("bearer mode is exempt (no ambient cookies → not CSRF-able)", async () => {
    const ext = firebaseAuth({ ...failingAuth, mode: "bearer" });
    const req: any = {
      method: "POST",
      url: "/users",
      headers: { host: "api.example" },
    };
    const res = makeRes();
    await ext.middleware(req, res, async () => {});
    // Falls through to auth (401), never the CSRF 403.
    expect(res.statusCode).toBe(401);
  });
});

describe("#07 open redirect is neutralised in the login page", () => {
  function loginHtmlFor(url: string): string {
    const ext = firebaseAuth({ ...failingAuth, mode: "cookie" });
    const route = ext.routes.find((r) => r.path === "/__login" && r.method === "GET");
    if (!route) throw new Error("login route missing");
    const req: any = { method: "GET", url, headers: { host: "victim.com" }, query: {} };
    const res = makeRes();
    route.handler(req, res);
    return String(res.body);
  }

  test("protocol-relative next collapses to '/'", () => {
    const html = loginHtmlFor("//evil.com/path");
    expect(html).toContain('const NEXT = "/"');
    expect(html).not.toContain("evil.com");
  });

  test("backslash-escaped next collapses to '/'", () => {
    const html = loginHtmlFor("/\\evil.com");
    expect(html).toContain('const NEXT = "/"');
    expect(html).not.toContain("evil.com");
  });

  test("a legitimate same-origin path is preserved", () => {
    const html = loginHtmlFor("/admin/users?ob=email");
    expect(html).toContain("/admin/users?ob=email");
  });
});
