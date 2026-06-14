/**
 * Firebase Auth helper for the admin & CRUD servers.
 *
 * Returns an {@link AuthExtension} ready to plug into `servers.admin()` or
 * `servers.crud()`. Supports two transport modes:
 *
 * - **`cookie`** — session cookie pattern (default for admin UIs). Mounts
 *   `/__login`, `/__session`, `/__logout` routes; the page lets the user sign
 *   in client-side with the Firebase JS SDK and exchanges the resulting ID
 *   token for an HttpOnly session cookie via Firebase Admin SDK.
 * - **`bearer`** — verifies `Authorization: Bearer <idToken>` on every request
 *   (default for REST APIs). No login routes mounted.
 * - **`both`** — accept either cookie or bearer.
 *
 * The helper is **agnostic** about authorization: pass an `allow` callback
 * returning whatever role/context shape you need. The result is exposed as
 * `req.user.context` to downstream middlewares and route handlers.
 *
 * @example Admin (cookie + role trio)
 * ```ts
 * import { firebaseAuth } from "@lpdjs/firestore-repo-service/servers/auth";
 * import { getAuth } from "firebase-admin/auth";
 *
 * servers.admin({
 *   auth: firebaseAuth({
 *     getAuth,
 *     mode: "cookie",
 *     apiKey: process.env.FIREBASE_WEB_API_KEY!,
 *     authDomain: process.env.FIREBASE_AUTH_DOMAIN!,
 *     allow: ({ email, claims }) => {
 *       if (claims.superAdmin) return { role: "superAdmin" };
 *       if (email?.endsWith("@solarpush.io")) return { role: "admin" };
 *       if (email) return { role: "viewer" };
 *       return null;
 *     },
 *   }),
 *   repos: { ... },
 * });
 * ```
 *
 * @example CRUD (bearer + business rules per repo)
 * ```ts
 * servers.crud({
 *   auth: firebaseAuth({ getAuth, mode: "bearer", allow: (u) => u }),
 *   repos: {
 *     comments: {
 *       repo: repos.comments,
 *       rules: {
 *         list:   () => true,
 *         get:    ({ user, doc }) => doc.public || doc.authorId === user.uid,
 *         create: ({ user })      => !!user.uid,
 *         update: ({ user, doc }) => user.uid === doc.authorId,
 *         delete: ({ user, doc }) => user.claims.role === "moderator",
 *       },
 *     },
 *   },
 * });
 * ```
 */

import type { AnyReq, Middleware, RouteHandler } from "../admin/router";
import { getLinkBase } from "../utils/link-base";
import { renderLoginPage } from "./login-page";
import {
  createLogoutHandler,
  createSessionHandler,
  parseCookies,
  SESSION_COOKIE_DEFAULT,
} from "./session";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal Firebase Admin Auth surface needed by this helper.
 * Avoids a hard import of `firebase-admin/auth` so the package stays
 * decoupled from a specific firebase-admin version.
 */
export interface FirebaseAdminAuthLike {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<DecodedIdTokenLike>;
  verifySessionCookie(
    sessionCookie: string,
    checkRevoked?: boolean,
  ): Promise<DecodedIdTokenLike>;
  createSessionCookie(
    idToken: string,
    sessionCookieOptions: { expiresIn: number },
  ): Promise<string>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface DecodedIdTokenLike {
  uid: string;
  email?: string;
  email_verified?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [claim: string]: any;
}

/** Identity attached to every authenticated request as `req.user`. */
export interface AuthUser<TContext = unknown> {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  claims: Record<string, any>;
  /** Result of the user-supplied `allow()` callback. */
  context: TContext;
}

/** A route descriptor mounted by `firebaseAuth` before the protected chain. */
export interface AuthRoute {
  method: "GET" | "POST";
  path: string;
  handler: RouteHandler;
}

/**
 * Returned by {@link firebaseAuth}. Servers detect this shape (vs.
 * `BasicAuthConfig` / raw `Middleware`) and mount the routes before pushing
 * the middleware onto the chain.
 */
export interface AuthExtension {
  readonly __authExtension: true;
  middleware: Middleware;
  /** Auxiliary routes (login page, session, logout). Empty in pure bearer mode. */
  routes: AuthRoute[];
  /** Path used to redirect unauthenticated browser requests. */
  loginPath: string;
}

export type FirebaseAuthMode = "cookie" | "bearer" | "both";

/** Provider configuration for the bundled login page. */
export interface FirebaseAuthLoginPageConfig {
  /** Page title. Default: "Admin sign-in". */
  title?: string;
  /**
   * Providers shown on the login page.
   * Default: `["password", "google"]`.
   */
  providers?: ("password" | "google")[];
}

export interface FirebaseAuthConfig<TContext = unknown> {
  /** Lazy getter for the Firebase Admin Auth instance. */
  getAuth: () => FirebaseAdminAuthLike;

  /** Transport mode. Default: `"cookie"`. */
  mode?: FirebaseAuthMode;

  /**
   * Authorization callback. Receives the verified token claims and returns:
   * - a context object → request is allowed, exposed as `req.user.context`,
   * - `null` → request is rejected (401 / redirect to login).
   *
   * If omitted, the default policy allows any authenticated user with
   * `context = null`.
   */
  allow?: (
    user: Omit<AuthUser, "context">,
  ) => TContext | null | Promise<TContext | null>;

  // ── Cookie mode options ────────────────────────────────────────────────
  /**
   * Whether to mount the bundled `/__login`, `/__session`, `/__logout`
   * routes. Default: `true` for `cookie`/`both`, `false` for `bearer`.
   */
  loginPage?: boolean | FirebaseAuthLoginPageConfig;

  /**
   * Firebase Web API key required by the JS SDK on the login page.
   * Mandatory when `loginPage` is enabled. Find it in your Firebase Console
   * under Project Settings → General → Web app config.
   */
  apiKey?: string;

  /**
   * Firebase Auth domain (e.g. `my-project.firebaseapp.com`).
   * Mandatory when `loginPage` is enabled.
   */
  authDomain?: string;

  /** Cookie name. Default: `__admin_session`. */
  cookieName?: string;

  /** Session cookie TTL in days. Default: `5` (Firebase max is 14). */
  sessionTtlDays?: number;

  /**
   * Cookie `Secure` flag. Default: `true`. Set to `false` only for local
   * development over HTTP.
   */
  secureCookie?: boolean;

  /** Cookie `SameSite`. Default: `"Lax"`. */
  sameSite?: "Strict" | "Lax" | "None";

  /**
   * Enable the built-in CSRF defense: state-changing requests
   * (`POST`/`PUT`/`PATCH`/`DELETE`) authenticated by **session cookie** must
   * carry an `Origin`/`Referer` header matching the request host. Bearer
   * requests are exempt (a browser never auto-attaches an `Authorization`
   * header, so they are not CSRF-able).
   *
   * **Defaults to `true` only when `sameSite: "None"`** (and not in `bearer`
   * mode). With the default `Lax`/`Strict` cookie the browser already blocks
   * the session cookie on cross-site mutations, so the check is unnecessary
   * and is left off to avoid false positives behind proxies whose `Host`
   * differs from the public origin (e.g. Cloud Functions v2 / Cloud Run).
   * Set to `true` to force the check on regardless of `sameSite`, or `false`
   * to disable it even with `sameSite: "None"` (only if you implement your
   * own CSRF protection upstream).
   */
  csrfProtection?: boolean;

  /**
   * Behaviour when authentication fails or `allow()` returns `null`.
   * - `"redirect"` (default in cookie mode) → 302 to the login page,
   * - `"401"` (default in bearer mode)     → JSON 401 response.
   */
  onUnauthenticated?: "redirect" | "401";

  /**
   * Routes that should bypass the auth middleware (matched against the path
   * after the basePath stripping). The auxiliary login routes are always
   * public regardless of this option.
   */
  publicPaths?: (string | RegExp)[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLoginPage(mode: FirebaseAuthMode): boolean {
  return mode === "cookie" || mode === "both";
}

function defaultUnauth(mode: FirebaseAuthMode): "redirect" | "401" {
  return mode === "bearer" ? "401" : "redirect";
}

function pathOf(req: AnyReq): string {
  const raw = req.path ?? req.url ?? "/";
  const idx = raw.indexOf("?");
  return idx === -1 ? raw : raw.slice(0, idx);
}

function queryAction(req: AnyReq): string | null {
  const q = (req as { query?: Record<string, unknown> }).query;
  if (q && typeof q.__action === "string") return q.__action;
  // Fallback: parse from URL when query parsing isn't done by the runtime.
  const url = req.url ?? "";
  const idx = url.indexOf("?");
  if (idx === -1) return null;
  const params = new URLSearchParams(url.slice(idx + 1));
  return params.get("__action");
}

function methodOf(req: AnyReq): string {
  return String(req.method ?? "GET").toUpperCase();
}

/**
 * Strip a redirect / `next` target down to a safe **same-origin path**.
 *
 * Rejects protocol-relative (`//evil.com`), backslash-escaped (`/\evil.com`)
 * and absolute (`https://…`) targets that would let an attacker turn the
 * post-login redirect into an open redirect / phishing vector (issue #07).
 * Anything suspicious collapses to `"/"`.
 */
function sanitizeNextPath(next: string): string {
  if (typeof next !== "string" || next.length === 0) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.includes("://")) return "/";
  return next;
}

function headerOf(req: AnyReq, name: string): string | undefined {
  const raw = req.headers?.[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Same-origin check used as a CSRF defense for state-changing requests.
 * Compares the request `Origin` (or `Referer`) host against the request host.
 * Returns `true` only when they match. A missing/invalid Origin fails closed.
 */
function isSameOriginRequest(req: AnyReq): boolean {
  const originHeader = headerOf(req, "origin") ?? headerOf(req, "referer");
  if (!originHeader) return false;
  const host = headerOf(req, "x-forwarded-host") ?? headerOf(req, "host");
  if (!host) return false;
  try {
    return new URL(originHeader).host === host;
  } catch {
    return false;
  }
}

function isPublic(
  path: string,
  patterns: (string | RegExp)[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (typeof p === "string") {
      if (path === p || path.startsWith(p + "/")) return true;
    } else if (p.test(path)) {
      return true;
    }
  }
  return false;
}

function wantsHtml(req: AnyReq): boolean {
  const accept = String(req.headers?.accept ?? "");
  // Strict: only real browser navigations advertise `text/html`. Treating
  // `*/*` or a missing Accept header as HTML caused curl, healthchecks and
  // server-to-server fetches to receive a 200 login page instead of a clear
  // 401 (issue #16).
  return accept.includes("text/html");
}

function extractBearer(req: AnyReq): string | null {
  const raw = req.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

function rejectUnauthenticated(
  req: AnyReq,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any,
  policy: "redirect" | "401",
  loginPath: string,
): void {
  if (policy === "redirect" && wantsHtml(req)) {
    const target = encodeURIComponent(req.url ?? "/");
    res
      .status(302)
      .set("Location", `${loginPath}?next=${target}`)
      .set("Cache-Control", "no-store")
      .end();
    return;
  }
  res
    .status(401)
    .set("Content-Type", "application/json; charset=utf-8")
    .send(JSON.stringify({ success: false, error: "Unauthorized" }));
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a Firebase Auth extension for use with `servers.admin()` or
 * `servers.crud()`. See module-level docs for the full design and examples.
 */
export function firebaseAuth<TContext = unknown>(
  config: FirebaseAuthConfig<TContext>,
): AuthExtension {
  const mode: FirebaseAuthMode = config.mode ?? "cookie";
  const cookieName = config.cookieName ?? SESSION_COOKIE_DEFAULT;
  const ttlDays = config.sessionTtlDays ?? 5;
  const secure = config.secureCookie ?? true;
  const sameSite = config.sameSite ?? "Lax";
  // The Origin/Referer (CSRF) check is only needed when `SameSite=None`:
  // with the default `Lax` (or `Strict`) the browser already refuses to send
  // the session cookie on cross-site state-changing requests, so a cross-site
  // POST/PUT/DELETE is unauthenticated and harmless. Enforcing the Origin
  // check unconditionally also breaks legitimate same-origin requests on
  // platforms where the container's `Host` differs from the public origin
  // (e.g. Cloud Functions v2 / Cloud Run, where `Host` is the internal
  // `*.run.app` host while `Origin` is the `*.cloudfunctions.net` domain).
  // Can be forced on/off explicitly via `csrfProtection`.
  const csrfProtection =
    config.csrfProtection ?? (mode !== "bearer" && sameSite === "None");
  if (mode !== "bearer" && sameSite === "None") {
    console.warn(
      "[firebaseAuth] `sameSite: \"None\"` disables the browser's built-in " +
        "SameSite CSRF protection. " +
        (csrfProtection
          ? "The same-origin (Origin/Referer) check is active as the primary " +
            "defense — ensure state-changing requests are sent same-origin or " +
            "carry a bearer token."
          : "`csrfProtection` is disabled — your endpoints are CSRF-exposed."),
    );
  }
  const onUnauth = config.onUnauthenticated ?? defaultUnauth(mode);
  const loginEnabled =
    config.loginPage === undefined
      ? defaultLoginPage(mode)
      : config.loginPage !== false;

  const loginPath = "/__login";
  const sessionPath = "/__session";
  const logoutPath = "/__logout";

  // ── Auxiliary handlers (kept in `routes` for hosting deployments
  // where users can mount them at known paths, AND invoked in-band by the
  // middleware on `?__action=session|logout` so vanilla Cloud Functions
  // — where there is no separate URL prefix per route — work too). ──────
  const sessionHandler = createSessionHandler({
    getAuth: config.getAuth,
    cookieName,
    ttlDays,
    secure,
    sameSite,
  });
  const logoutHandler = createLogoutHandler({
    getAuth: config.getAuth,
    cookieName,
    secure,
    sameSite,
  });

  function renderInlineLogin(
    req: AnyReq,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: any,
    error: string | null = null,
    status = 200,
  ): void {
    // Validate lazily (at request time) so module loading during Firebase CLI
    // analysis doesn't throw before env vars are injected.
    if (!config.apiKey || !config.authDomain) {
      throw new Error(
        "[firebaseAuth] `apiKey` and `authDomain` are required when `loginPage` is enabled. " +
          "Find both in the Firebase Console under Project Settings → General → Web app config.",
      );
    }
    const pageCfg: FirebaseAuthLoginPageConfig =
      typeof config.loginPage === "object" ? config.loginPage : {};
    // Build a same-function absolute URL: the function's external prefix
    // (Cloud Functions name, emulator project/region/target, or "" for
    // custom domains) + the in-router request path. The browser otherwise
    // resolves form actions relative to the public URL, which doesn't
    // include the function name on Cloud Functions.
    const prefix = getLinkBase(req, "/");
    const inner = req.url ?? "/";
    // Sanitize to a same-origin path so a crafted request URL (e.g.
    // `//evil.com/...` on a custom domain where the prefix is empty) cannot
    // turn the post-login redirect or the form action into an open redirect
    // (issue #07).
    const fullPath = sanitizeNextPath(
      `${prefix}${inner.startsWith("/") ? inner : `/${inner}`}`,
    );
    const sep = fullPath.includes("?") ? "&" : "?";
    const sessionAction = `${fullPath}${sep}__action=session`;
    const html = renderLoginPage({
      title: pageCfg.title ?? "Admin sign-in",
      providers: pageCfg.providers ?? ["password", "google"],
      apiKey: config.apiKey!,
      authDomain: config.authDomain!,
      sessionPath: sessionAction,
      next: fullPath,
      error,
    });
    res
      .status(status)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(html);
  }

  // ── Auxiliary routes ─────────────────────────────────────────────────────
  const routes: AuthRoute[] = [];
  if (loginEnabled) {
    routes.push({
      method: "GET",
      path: loginPath,
      handler: (req, res) => {
        const error = (req.query?.error as string | undefined) ?? null;
        renderInlineLogin(req, res, error);
      },
    });
    routes.push({
      method: "POST",
      path: sessionPath,
      handler: sessionHandler,
    });
    routes.push({
      method: "POST",
      path: logoutPath,
      handler: logoutHandler,
    });
  }

  const publicPaths: (string | RegExp)[] = [
    ...(config.publicPaths ?? []),
    loginPath,
    sessionPath,
    logoutPath,
  ];

  // ── Middleware ───────────────────────────────────────────────────────────
  const middleware: Middleware = async (req, res, next) => {
    const path = pathOf(req);
    const method = methodOf(req);

    // 0. CSRF defense for cookie sessions (only active when `SameSite=None`,
    //    or when `csrfProtection` is explicitly forced on — see config). With
    //    the default Lax/Strict cookie the browser already blocks the session
    //    cookie on cross-site state-changing requests, so this is skipped to
    //    avoid breaking legitimate same-origin requests behind proxies. When
    //    active it runs FIRST so it also protects the in-band
    //    `?__action=logout|session` shortcut below (issues #05, #06).
    if (
      csrfProtection &&
      mode !== "bearer" &&
      !CSRF_SAFE_METHODS.has(method) &&
      !extractBearer(req) &&
      !isSameOriginRequest(req)
    ) {
      res
        .status(403)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(
          JSON.stringify({
            success: false,
            error: "Origin check failed (possible CSRF)",
          }),
        );
      return;
    }

    // 1. In-band action endpoints. The bundled login page posts the session
    //    exchange (and logout) to the CURRENT url with `?__action=session`
    //    (resp. `logout`) rather than to the mounted `/__session` route,
    //    because on vanilla Cloud Functions the helper cannot reliably know
    //    the function's public URL prefix to address a separate route. These
    //    actions are inherently public (login/logout need no prior auth) and
    //    are protected against cross-site abuse by the same-origin guard
    //    above (issue #06).
    if (loginEnabled && method === "POST") {
      const action = queryAction(req);
      if (action === "session") {
        await sessionHandler(req, res);
        return;
      }
      if (action === "logout") {
        await logoutHandler(req, res);
        return;
      }
    }

    // 2. Public paths (mounted login routes, user-supplied allowlist).
    if (isPublic(path, publicPaths)) {
      await next();
      return;
    }

    let decoded: DecodedIdTokenLike | null = null;
    try {
      const auth = config.getAuth();

      // Try bearer first when allowed (cheaper, no cookie parsing).
      if (mode === "bearer" || mode === "both") {
        const token = extractBearer(req);
        if (token) {
          decoded = await auth.verifyIdToken(token, true);
        }
      }

      // Fall back to cookie when allowed.
      if (!decoded && (mode === "cookie" || mode === "both")) {
        const cookieHeader = req.headers?.cookie;
        const raw = Array.isArray(cookieHeader)
          ? cookieHeader.join("; ")
          : cookieHeader;
        const cookies = parseCookies(typeof raw === "string" ? raw : "");
        const session = cookies[cookieName];
        if (session) {
          decoded = await auth.verifySessionCookie(session, true);
        }
      }
    } catch {
      decoded = null;
    }

    if (!decoded) {
      rejectUnauthenticated(req, res);
      return;
    }

    const baseUser: Omit<AuthUser, "context"> = {
      uid: decoded.uid,
      email: typeof decoded.email === "string" ? decoded.email : null,
      emailVerified: !!decoded.email_verified,
      claims: decoded as Record<string, unknown>,
    };

    let context: TContext | null;
    try {
      context = config.allow
        ? await config.allow(baseUser)
        : (null as TContext | null);
    } catch {
      context = null;
    }

    if (config.allow && context === null) {
      rejectUnauthenticated(req, res);
      return;
    }

    (req as AnyReq & { user?: AuthUser<TContext> }).user = {
      ...baseUser,
      context: context as TContext,
    };

    await next();
  };

  /**
   * Reject according to the configured policy:
   * - cookie/both + GET HTML browser request → render the login page inline
   *   on the SAME URL with a `401` status (works on Cloud Functions where
   *   there's no separate `/__login` route reachable from the public URL).
   *   A 401 keeps the response HTTP-compliant for monitoring/healthchecks
   *   while browsers still render the page (issue #16).
   * - bearer mode or non-HTML clients → JSON 401.
   */
  function rejectUnauthenticated(
    req: AnyReq,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: any,
  ): void {
    if (
      onUnauth === "redirect" &&
      loginEnabled &&
      methodOf(req) === "GET" &&
      wantsHtml(req)
    ) {
      renderInlineLogin(req, res, null, 401);
      return;
    }
    res
      .status(401)
      .set("Content-Type", "application/json; charset=utf-8")
      .send(JSON.stringify({ success: false, error: "Unauthorized" }));
  }

  return {
    __authExtension: true,
    middleware,
    routes,
    loginPath,
  };
}

/**
 * Type guard: detect an {@link AuthExtension} (vs. legacy
 * `BasicAuthConfig` / `Middleware`).
 */
export function isAuthExtension(value: unknown): value is AuthExtension {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { __authExtension?: unknown }).__authExtension === true
  );
}

/**
 * Helper for explicitly opening a CRUD operation when the server has
 * `auth` defined (bypasses the default-deny policy).
 *
 * @example
 * ```ts
 * rules: { list: allowAll, get: allowAll }
 * ```
 */
export const allowAll = (): true => true;
