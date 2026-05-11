/**
 * Session cookie + logout handlers for `firebaseAuth`.
 * Exchanges a Firebase ID token for an HttpOnly session cookie via the
 * Firebase Admin SDK (`createSessionCookie`), and clears it on logout.
 */

import type { RouteHandler } from "../admin/router";
import type { FirebaseAdminAuthLike } from "./firebase-auth";

export const SESSION_COOKIE_DEFAULT = "__admin_session";

interface SessionHandlerConfig {
  getAuth: () => FirebaseAdminAuthLike;
  cookieName: string;
  ttlDays: number;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface LogoutHandlerConfig {
  getAuth: () => FirebaseAdminAuthLike;
  cookieName: string;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

// ---------------------------------------------------------------------------
// Cookie utilities
// ---------------------------------------------------------------------------

/** Parse a `Cookie` header into a flat key→value map. Tolerant of malformed pairs. */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function buildSetCookie(
  name: string,
  value: string,
  opts: {
    maxAgeSeconds: number;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    path?: string;
  },
): string {
  const segments = [
    `${name}=${value}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) segments.push("Secure");
  return segments.join("; ");
}

/** Pull JSON body out of any Express-like request (works with `parseBody` already done by the host). */
function readJsonBody(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof body === "object") return body as Record<string, unknown>;
  return {};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `POST /__session` — receives `{ idToken }`, verifies it via the Admin SDK,
 * mints a session cookie, and sets it on the response.
 */
export function createSessionHandler(cfg: SessionHandlerConfig): RouteHandler {
  return async (req, res) => {
    const body = readJsonBody(req);
    const idToken = typeof body.idToken === "string" ? body.idToken : "";
    if (!idToken) {
      res
        .status(400)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(JSON.stringify({ success: false, error: "Missing idToken" }));
      return;
    }

    const expiresInMs = cfg.ttlDays * 24 * 60 * 60 * 1000;
    try {
      const auth = cfg.getAuth();
      // Verify first so we surface auth errors before minting the cookie.
      const decoded = await auth.verifyIdToken(idToken, true);
      // Reject very old sign-ins to encourage fresh re-auth (Google guidance: < 5 min).
      const authTimeRaw = (decoded as { auth_time?: number }).auth_time;
      const authTime =
        typeof authTimeRaw === "number" ? authTimeRaw * 1000 : Date.now();
      if (Date.now() - authTime > 5 * 60 * 1000) {
        res
          .status(401)
          .set("Content-Type", "application/json; charset=utf-8")
          .send(
            JSON.stringify({
              success: false,
              error: "Recent sign-in required",
            }),
          );
        return;
      }
      const sessionCookie = await auth.createSessionCookie(idToken, {
        expiresIn: expiresInMs,
      });
      const cookie = buildSetCookie(cfg.cookieName, encodeURIComponent(sessionCookie), {
        maxAgeSeconds: Math.floor(expiresInMs / 1000),
        secure: cfg.secure,
        sameSite: cfg.sameSite,
      });
      res
        .status(200)
        .set("Set-Cookie", cookie)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(JSON.stringify({ success: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid idToken";
      res
        .status(401)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(JSON.stringify({ success: false, error: message }));
    }
  };
}

/**
 * `POST /__logout` — clears the session cookie and revokes the user's refresh
 * tokens (best-effort; failure to revoke does not block the logout).
 */
export function createLogoutHandler(cfg: LogoutHandlerConfig): RouteHandler {
  return async (req, res) => {
    try {
      const cookieHeader = req.headers?.cookie;
      const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
      const cookies = parseCookies(typeof raw === "string" ? raw : "");
      const session = cookies[cfg.cookieName];
      if (session) {
        try {
          const auth = cfg.getAuth();
          const decoded = await auth.verifySessionCookie(session, false);
          await auth.revokeRefreshTokens(decoded.uid);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      const expired = buildSetCookie(cfg.cookieName, "", {
        maxAgeSeconds: 0,
        secure: cfg.secure,
        sameSite: cfg.sameSite,
      });
      res
        .status(200)
        .set("Set-Cookie", expired)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(JSON.stringify({ success: true }));
    }
  };
}
