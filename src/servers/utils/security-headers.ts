/**
 * Default security-headers middleware for the bundled HTTP servers.
 *
 * Addresses issues #12 (no security headers / clickjacking / cache leakage)
 * and #13 (no CSP bounding the CDN origins loaded by the admin & login pages).
 *
 * The middleware is framework-agnostic: it only touches `res.setHeader`
 * (present on Node's `ServerResponse` and the shims used by the admin/CRUD
 * routers) and always calls `next()`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRes = any;
type Next = () => void | Promise<void>;

/** CDN/script origins the bundled admin UI and login page load from. */
const ADMIN_CDN = "https://cdn.jsdelivr.net";
const GSTATIC = "https://www.gstatic.com";

/**
 * Reasonable default Content-Security-Policy for the bundled **HTML** pages
 * (admin UI + login). Allows the specific CDN origins the pages need and
 * forbids framing entirely. `'unsafe-inline'`/`'unsafe-eval'` are required by
 * the Tailwind browser build and the small inline bootstrap scripts.
 */
export const DEFAULT_HTML_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${ADMIN_CDN} ${GSTATIC}`,
  `style-src 'self' 'unsafe-inline' ${ADMIN_CDN}`,
  `connect-src 'self' ${GSTATIC} https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com`,
  "img-src 'self' data:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export interface SecurityHeadersOptions {
  /**
   * Content-Security-Policy value. Pass a string to override, or `false` to
   * omit the header entirely. Defaults to {@link DEFAULT_HTML_CSP} for HTML
   * servers (admin/login) and is omitted for pure JSON APIs unless provided.
   */
  csp?: string | false;
  /**
   * `X-Frame-Options` value. Default `"DENY"`. Pass `false` to omit (e.g. when
   * the app must be embedded in a trusted iframe — prefer a CSP
   * `frame-ancestors` allowlist instead).
   */
  frameOptions?: string | false;
  /** `Referrer-Policy` value. Default `"no-referrer"`. */
  referrerPolicy?: string | false;
  /**
   * `Cache-Control` value. Default `"private, no-store"` to keep private data
   * out of shared proxy caches. Pass `false` to leave caching to handlers.
   */
  cacheControl?: string | false;
}

/**
 * Build a middleware that sets a baseline of security response headers.
 *
 * @example
 * ```ts
 * router.use(securityHeaders());                 // HTML-safe defaults
 * router.use(securityHeaders({ csp: false }));   // JSON API (no CSP)
 * ```
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}) {
  const csp = opts.csp === undefined ? DEFAULT_HTML_CSP : opts.csp;
  const frameOptions = opts.frameOptions === undefined ? "DENY" : opts.frameOptions;
  const referrerPolicy =
    opts.referrerPolicy === undefined ? "no-referrer" : opts.referrerPolicy;
  const cacheControl =
    opts.cacheControl === undefined ? "private, no-store" : opts.cacheControl;

  return async (_req: AnyReq, res: AnyRes, next: Next): Promise<void> => {
    if (typeof res?.setHeader === "function") {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (frameOptions) res.setHeader("X-Frame-Options", frameOptions);
      if (referrerPolicy) res.setHeader("Referrer-Policy", referrerPolicy);
      if (cacheControl) res.setHeader("Cache-Control", cacheControl);
      if (csp) res.setHeader("Content-Security-Policy", csp);
    }
    await next();
  };
}
