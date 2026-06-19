/**
 * Hono-native auth guards for the OpenAPI docs / spec endpoints.
 *
 * These return plain Hono `MiddlewareHandler`s, so they slot into
 * `OpenAPIConfig.docsAuth` (which protects only `/docs` + `/openapi.json`,
 * never the API routes). For a fully custom flow, pass your own middleware
 * instead of these helpers.
 */

import type { MiddlewareHandler } from "hono";

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
