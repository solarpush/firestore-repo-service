/**
 * Hono-native auth guards for the OpenAPI docs / spec endpoints.
 *
 * These return plain Hono `MiddlewareHandler`s, so they slot into
 * `OpenAPIConfig.docsAuth` (which protects only `/docs` + `/openapi.json`,
 * never the API routes). For a fully custom flow, pass your own middleware
 * instead of these helpers.
 */

import type { MiddlewareHandler } from "hono";
import { renderLoginPage } from "../auth/login-page";
import { parseCookies } from "../auth/session";
import type {
  DecodedIdTokenLike,
  FirebaseAdminAuthLike,
} from "../auth/firebase-auth";

/** Decoded token shape — kept minimal to avoid a hard firebase-admin import. */
export interface DecodedBearerToken {
  uid: string;
  email?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [claim: string]: any;
}

/** Minimal Firebase Admin Auth surface used by {@link firebaseBearerAuth}. */
export interface FirebaseBearerAuthLike {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<DecodedBearerToken>;
}

/** Options for {@link firebaseBearerAuth}. */
export interface FirebaseBearerAuthOptions {
  /**
   * Returns the Firebase Admin Auth instance, e.g. `() => getAuth()`. Called
   * lazily on each request so `initializeApp()` runs first.
   */
  getAuth: () => FirebaseBearerAuthLike;
  /**
   * Authorization policy. Return `false` (or throw) to reject the request,
   * any truthy value to allow. Defaults to allowing any verified token.
   */
  allow?: (token: DecodedBearerToken) => boolean | Promise<boolean>;
  /** Revoke check passed to `verifyIdToken`. Default: `false`. */
  checkRevoked?: boolean;
  /**
   * Context key under which the decoded token is stored (`c.set(key, token)`)
   * for downstream handlers. Default: `"docsUser"`.
   */
  contextKey?: string;
}

/**
 * Guard the docs / spec endpoints with a Firebase ID token (Bearer scheme).
 *
 * @example
 * ```ts
 * import { getAuth } from "firebase-admin/auth";
 * import { firebaseBearerAuth } from "@lpdjs/firestore-repo-service/servers/hono";
 *
 * openapi: {
 *   info,
 *   docsAuth: firebaseBearerAuth({
 *     getAuth: () => getAuth(),
 *     allow: (t) => t.admin === true,
 *   }),
 * }
 * ```
 */
export function firebaseBearerAuth(
  options: FirebaseBearerAuthOptions,
): MiddlewareHandler {
  const {
    getAuth,
    allow,
    checkRevoked = false,
    contextKey = "docsUser",
  } = options;

  return async (c, next) => {
    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    let decoded: DecodedBearerToken;
    try {
      decoded = await getAuth().verifyIdToken(match[1]!, checkRevoked);
    } catch {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    if (allow) {
      let permitted = false;
      try {
        permitted = await allow(decoded);
      } catch {
        permitted = false;
      }
      if (!permitted) return c.json({ error: "Forbidden" }, 403);
    }

    c.set(contextKey, decoded);
    return next();
  };
}

/** Options for {@link basicAuth}. */
export interface BasicAuthOptions {
  username: string;
  password: string;
  /** Realm advertised in the `WWW-Authenticate` header. Default: `"Docs"`. */
  realm?: string;
}

/**
 * Guard the docs / spec endpoints with HTTP Basic Auth.
 *
 * @example
 * ```ts
 * openapi: { info, docsAuth: basicAuth({ username: "admin", password: "secret" }) }
 * ```
 */
export function basicAuth(options: BasicAuthOptions): MiddlewareHandler {
  const { username, password, realm = "Docs" } = options;
  const expected = `Basic ${btoa(`${username}:${password}`)}`;

  return async (c, next) => {
    const header =
      c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(header, expected)) {
      return c.text("Unauthorized", 401, {
        "WWW-Authenticate": `Basic realm="${realm}"`,
      });
    }
    return next();
  };
}

/** Constant-time string comparison to avoid leaking length/contents via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ===========================================================================
// Firebase login-form auth (session cookie) — mirrors the admin server flow
// ===========================================================================

/** A bare auxiliary route name (relative to the docs directory). */
export interface DocsAuthRoute {
  method: "GET" | "POST";
  /** Bare path segment relative to the docs directory, e.g. `"__login"`. */
  name: string;
  handler: MiddlewareHandler;
}

/**
 * Richer `docsAuth` value (vs. a bare `MiddlewareHandler`): a guard middleware
 * **plus** auxiliary routes (login page, session exchange, logout) that the
 * {@link HonoServer} mounts next to the docs/spec endpoints. Mirrors the admin
 * server's `AuthExtension`. Produced by {@link firebaseDocsAuth}.
 */
export interface DocsAuthExtension {
  readonly __docsAuthExtension: true;
  /** Guard applied to the docs UI + JSON spec endpoints. */
  middleware: MiddlewareHandler;
  /** Auxiliary routes mounted (unguarded) in the docs directory. */
  routes: DocsAuthRoute[];
  /** Bare login route name, used to redirect unauthenticated browsers. */
  loginName: string;
}

/** Type guard distinguishing a {@link DocsAuthExtension} from a raw middleware. */
export function isDocsAuthExtension(value: unknown): value is DocsAuthExtension {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __docsAuthExtension?: unknown }).__docsAuthExtension === true
  );
}

/** Options for {@link firebaseDocsAuth}. */
export interface FirebaseDocsAuthOptions {
  /**
   * Returns the Firebase Admin Auth instance, e.g. `() => getAuth()`. Called
   * lazily on each request so `initializeApp()` runs first. Must expose
   * `verifyIdToken`, `verifySessionCookie`, `createSessionCookie`,
   * `revokeRefreshTokens`.
   */
  getAuth: () => FirebaseAdminAuthLike;
  /** Firebase Web API key — required by the JS SDK on the login page. */
  apiKey: string;
  /** Firebase Auth domain (e.g. `my-project.firebaseapp.com`). */
  authDomain: string;
  /**
   * Transport mode. `"cookie"` (default) gates the docs behind the bundled
   * login form + a server-side session cookie. `"both"` additionally accepts a
   * `Bearer` ID token (handy to embed the docs in an authenticated iframe).
   */
  mode?: "cookie" | "both";
  /**
   * Authorization policy. Return `false` (or throw) to reject, any truthy value
   * to allow. Defaults to allowing any verified user. Receives the decoded
   * ID-token / session-cookie claims.
   */
  allow?: (token: DecodedIdTokenLike) => boolean | Promise<boolean>;
  /** Providers shown on the login page. Default: `["password", "google"]`. */
  providers?: ("password" | "google")[];
  /** Login page title. Default: `"Docs sign-in"`. */
  title?: string;
  /** Session cookie name. Default: `"__docs_session"`. */
  cookieName?: string;
  /** Session cookie TTL in days. Default: `5` (Firebase max is 14). */
  sessionTtlDays?: number;
  /** Cookie `Secure` flag. Default: `true` (set `false` only for local HTTP). */
  secureCookie?: boolean;
  /** Cookie `SameSite`. Default: `"Lax"`. */
  sameSite?: "Strict" | "Lax" | "None";
  /**
   * Context key under which the decoded token is stored (`c.set(key, token)`)
   * for downstream handlers. Default: `"docsUser"`.
   */
  contextKey?: string;
  /**
   * Behaviour when authentication fails. `"redirect"` (default) sends browser
   * `GET`s to the login page; `"401"` always returns a JSON 401.
   */
  onUnauthenticated?: "redirect" | "401";
  /**
   * Firebase Auth emulator host (e.g. `127.0.0.1:9099`). When set, the login
   * page's client SDK targets the emulator via `connectAuthEmulator`, matching
   * the Admin SDK (which already routes to the emulator when
   * `FIREBASE_AUTH_EMULATOR_HOST` is set). Defaults to that env var; pass `""`
   * to force it off.
   */
  authEmulatorHost?: string;
}

const LOGIN_NAME = "__login";
const SESSION_NAME = "__session";
const LOGOUT_NAME = "__logout";

/** Last path segment, e.g. `/v1/docs` → `docs`. Empty string for `/`. */
function lastSegment(path: string): string {
  const segs = path.split("?")[0]!.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

/** Build a `Set-Cookie` header value (HttpOnly, path-scoped). */
function buildSetCookie(
  name: string,
  value: string,
  opts: {
    maxAgeSeconds: number;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  },
): string {
  const segments = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) segments.push("Secure");
  return segments.join("; ");
}

/** Restrict a `next` target to a simple same-origin relative token. */
function sanitizeNext(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.startsWith("/") || raw.includes("://") || raw.includes("\\")) {
    return fallback;
  }
  return raw;
}

/**
 * Guard the docs / spec endpoints with a Firebase **login form + session
 * cookie**, the same flow as the admin server — instead of forcing callers to
 * craft a `Bearer` token by hand.
 *
 * Returns a {@link DocsAuthExtension}: pass it straight to
 * `OpenAPIConfig.docsAuth`. The {@link HonoServer} mounts the bundled
 * `__login` / `__session` / `__logout` routes next to the docs and applies the
 * guard. Unauthenticated browsers are redirected to the login page; once signed
 * in, an HttpOnly session cookie keeps them authenticated.
 *
 * @example
 * ```ts
 * import { getAuth } from "firebase-admin/auth";
 * import { firebaseDocsAuth } from "@lpdjs/firestore-repo-service/servers/hono";
 *
 * openapi: {
 *   info,
 *   docsAuth: firebaseDocsAuth({
 *     getAuth: () => getAuth(),
 *     apiKey: process.env.FIREBASE_API_KEY!,
 *     authDomain: process.env.FIREBASE_AUTH_DOMAIN!,
 *     allow: (t) => t.admin === true, // optional policy
 *   }),
 * }
 * ```
 */
export function firebaseDocsAuth(
  options: FirebaseDocsAuthOptions,
): DocsAuthExtension {
  const {
    getAuth,
    apiKey,
    authDomain,
    mode = "cookie",
    allow,
    providers = ["password", "google"],
    title = "Docs sign-in",
    cookieName = "__docs_session",
    sessionTtlDays = 5,
    secureCookie = true,
    sameSite = "Lax",
    contextKey = "docsUser",
    onUnauthenticated = "redirect",
    authEmulatorHost = process.env["FIREBASE_AUTH_EMULATOR_HOST"],
  } = options;

  async function passesAllow(token: DecodedIdTokenLike): Promise<boolean> {
    if (!allow) return true;
    try {
      return Boolean(await allow(token));
    } catch {
      return false;
    }
  }

  // ── Login page (GET __login) ──────────────────────────────────────────────
  const loginHandler: MiddlewareHandler = async (c) => {
    // Validate lazily (at request time) so importing this module during the
    // Firebase CLI analysis / emulator load doesn't throw before env vars are
    // injected — same approach as the admin `firebaseAuth`.
    if (!apiKey || !authDomain) {
      throw new Error(
        "[firebaseDocsAuth] `apiKey` and `authDomain` are required for the login " +
          "page. Find both in the Firebase Console → Project Settings → General → " +
          "Web app config.",
      );
    }
    const next = sanitizeNext(c.req.query("next"), "docs");
    const error = c.req.query("error") ?? null;
    const html = renderLoginPage({
      title,
      providers,
      apiKey,
      authDomain,
      // Relative to the login page URL (resolved client-side), so it works
      // behind any Cloud Functions / reverse-proxy prefix.
      sessionPath: SESSION_NAME,
      next,
      error,
      authEmulatorHost,
    });
    return c.html(html, 200, { "Cache-Control": "no-store" });
  };

  // ── Session exchange (POST __session) ─────────────────────────────────────
  const sessionHandler: MiddlewareHandler = async (c) => {
    let idToken = "";
    try {
      const body = (await c.req.json()) as { idToken?: unknown };
      idToken = typeof body.idToken === "string" ? body.idToken : "";
    } catch {
      idToken = "";
    }
    if (!idToken) {
      return c.json({ success: false, error: "Missing idToken" }, 400);
    }

    const expiresInMs = sessionTtlDays * 24 * 60 * 60 * 1000;
    try {
      const auth = getAuth();
      const decoded = await auth.verifyIdToken(idToken, true);
      if (!(await passesAllow(decoded))) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
      // Reject stale sign-ins (Google guidance: require a recent auth, < 5 min).
      const authTimeRaw = (decoded as { auth_time?: number }).auth_time;
      const authTime =
        typeof authTimeRaw === "number" ? authTimeRaw * 1000 : Date.now();
      if (Date.now() - authTime > 5 * 60 * 1000) {
        return c.json(
          { success: false, error: "Recent sign-in required" },
          401,
        );
      }
      const sessionCookie = await auth.createSessionCookie(idToken, {
        expiresIn: expiresInMs,
      });
      const cookie = buildSetCookie(
        cookieName,
        encodeURIComponent(sessionCookie),
        {
          maxAgeSeconds: Math.floor(expiresInMs / 1000),
          secure: secureCookie,
          sameSite,
        },
      );
      c.header("Set-Cookie", cookie);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid idToken";
      return c.json({ success: false, error: message }, 401);
    }
  };

  // ── Logout (POST __logout) ────────────────────────────────────────────────
  const logoutHandler: MiddlewareHandler = async (c) => {
    const cookies = parseCookies(c.req.header("cookie") ?? "");
    const session = cookies[cookieName];
    if (session) {
      try {
        const auth = getAuth();
        const decoded = await auth.verifySessionCookie(session, false);
        await auth.revokeRefreshTokens(decoded.uid);
      } catch {
        /* best-effort */
      }
    }
    c.header(
      "Set-Cookie",
      buildSetCookie(cookieName, "", {
        maxAgeSeconds: 0,
        secure: secureCookie,
        sameSite,
      }),
    );
    return c.json({ success: true });
  };

  // ── Guard middleware (docs + spec) ────────────────────────────────────────
  const middleware: MiddlewareHandler = async (c, next) => {
    const auth = getAuth();

    // mode "both": accept a Bearer ID token first (e.g. iframe embedding).
    if (mode === "both") {
      const header =
        c.req.header("authorization") ?? c.req.header("Authorization");
      const match = header?.match(/^Bearer\s+(.+)$/i);
      if (match) {
        try {
          const decoded = await auth.verifyIdToken(match[1]!, false);
          if (await passesAllow(decoded)) {
            c.set(contextKey, decoded);
            return next();
          }
        } catch {
          /* fall through to cookie / unauthenticated */
        }
      }
    }

    // Session cookie.
    const cookies = parseCookies(c.req.header("cookie") ?? "");
    const session = cookies[cookieName];
    if (session) {
      try {
        const decoded = await auth.verifySessionCookie(session, false);
        if (await passesAllow(decoded)) {
          c.set(contextKey, decoded);
          return next();
        }
      } catch {
        /* unauthenticated */
      }
    }

    // Unauthenticated.
    const accept = c.req.header("accept") ?? "";
    const isBrowserGet =
      c.req.method === "GET" && accept.includes("text/html");
    if (onUnauthenticated === "redirect" && isBrowserGet) {
      const target = encodeURIComponent(lastSegment(c.req.path) || "docs");
      // Relative to the requested page (login route is a sibling), so the
      // external prefix is preserved by the browser.
      return c.redirect(`${LOGIN_NAME}?next=${target}`, 302);
    }
    return c.json({ error: "Unauthorized" }, 401);
  };

  return {
    __docsAuthExtension: true,
    middleware,
    loginName: LOGIN_NAME,
    routes: [
      { method: "GET", name: LOGIN_NAME, handler: loginHandler },
      { method: "POST", name: SESSION_NAME, handler: sessionHandler },
      { method: "POST", name: LOGOUT_NAME, handler: logoutHandler },
    ],
  };
}
