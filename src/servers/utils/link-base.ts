/**
 * Compute the URL prefix used to build absolute paths from inside a
 * Firebase HTTPS function. Handles three deployment shapes uniformly:
 *
 * 1. **Firebase emulator** (`FUNCTIONS_EMULATOR=true`) — exposes functions at
 *    `http://localhost:5001/{project}/{region}/{functionTarget}/...`. The
 *    handler receives `req.url` *without* this prefix, so we rebuild it from
 *    `GCLOUD_PROJECT`, `FUNCTION_REGION`, `FUNCTION_TARGET`.
 *
 * 2. **Cloud Functions v2 default URL** (`*.cloudfunctions.net/{name}`) —
 *    Cloud Run terminates routing at the service name, so links must include
 *    the `K_SERVICE` prefix. Detected via the `host` header containing
 *    `cloudfunctions.net`.
 *
 * 3. **Custom domain / Hosting rewrite** — the proxy strips the prefix
 *    before reaching the handler, so links are relative to the configured
 *    `staticBasePath`.
 *
 * @param req           The incoming request (needs `headers.host` / `hostname`).
 * @param staticBasePath The user-configured base path (e.g. `"/api"`).
 * @returns A path prefix (no trailing slash) suitable for prepending to
 *          `req.url` to build a same-function absolute URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getLinkBase(req: any, staticBasePath: string): string {
  const base = staticBasePath === "/" ? "" : staticBasePath.replace(/\/$/, "");

  if (process.env["FUNCTIONS_EMULATOR"] === "true") {
    const project =
      process.env["GCLOUD_PROJECT"] ??
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      "demo-project";
    const region = process.env["FUNCTION_REGION"] ?? "us-central1";
    // FUNCTION_TARGET uses dots (e.g. "sync.functions.adminsync") but the
    // emulator URL uses hyphens ("sync-functions-adminsync").
    const target = (process.env["FUNCTION_TARGET"] ?? "").replace(/\./g, "-");
    return `/${project}/${region}/${target}${base}`;
  }

  // Cloud Functions v2: K_SERVICE = function name = URL path prefix.
  // Only add it when accessed via cloudfunctions.net (not custom domains).
  // Cloud Run (Gen 2) lowercases service names, but K_SERVICE may still
  // carry the original mixed-case export name — normalise to lowercase
  // so that generated links match the canonical URL.
  const service = process.env["K_SERVICE"];
  const host: string =
    req?.hostname ?? req?.headers?.["host"] ?? "";
  if (service && typeof host === "string" && host.includes("cloudfunctions.net")) {
    return `/${service.toLowerCase()}${base}`;
  }

  return base;
}
