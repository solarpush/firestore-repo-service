/**
 * Build a deep link to the GCP Cloud Logging "Logs Explorer", pre-filtered on a
 * correlation id, so a developer can jump straight from an HTTP error response
 * to the matching structured log.
 *
 * Designed as a dev ergonomic: keep it **disabled in production** (the link is
 * meant for engineers, not end users) and enable it locally / in staging. The
 * `errorId` returned by {@link BaseLogger.error} and carried by your `AppError`
 * is the same value used both in the response body and in the link's query.
 *
 * @example
 * ```ts
 * // package-level helper
 * const url = gcpLogsUrl(error.errorId, {
 *   enabled: process.env.NODE_ENV !== "production",
 *   projectId: "my-gcp-project", // or omit to read it from the environment
 * });
 *
 * // inside BaseErrorHandler.mapError
 * return c.json({ error: msg, errorId, ...(url ? { logsUrl: url } : {}) }, 412);
 * ```
 */

/** Options controlling {@link gcpLogsUrl}. */
export interface GcpLogsLinkOptions {
  /**
   * Master switch — when falsy, {@link gcpLogsUrl} returns `undefined` and no
   * link is produced. Default: `false` (opt-in). Wire it to e.g.
   * `process.env.NODE_ENV !== "production"`.
   */
  enabled?: boolean;
  /**
   * GCP project id. Defaults to the first non-empty of
   * `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GCP_PROJECT` (all auto-set on
   * Cloud Functions / Cloud Run). When none is resolvable, no link is built.
   */
  projectId?: string;
  /**
   * Structured-log field that carries the correlation id. Must match what your
   * logger writes (the package's {@link BaseLogger} writes `errorId`).
   * Default: `"errorId"`.
   */
  field?: string;
  /**
   * Optional lookback window appended to the query as an ISO-8601 duration
   * (e.g. `"PT1H"`, `"PT30M"`, `"P1D"`). Omit to let the Logs Explorer use its
   * default range.
   */
  duration?: string;
}

/**
 * Resolve the GCP project id from an explicit value, falling back to the
 * standard environment variables. Returns `undefined` when none is set.
 */
export function resolveGcpProjectId(explicit?: string): string | undefined {
  return (
    explicit ||
    process.env["GOOGLE_CLOUD_PROJECT"] ||
    process.env["GCLOUD_PROJECT"] ||
    process.env["GCP_PROJECT"] ||
    undefined
  );
}

/**
 * Build the Logs Explorer URL filtered on `<field>="<errorId>"`, or return
 * `undefined` when the feature is disabled, the `errorId` is missing, or no
 * project id can be resolved (so callers can spread it safely).
 */
export function gcpLogsUrl(
  errorId: string | undefined,
  options: GcpLogsLinkOptions = {},
): string | undefined {
  if (!options.enabled || !errorId) return undefined;

  const projectId = resolveGcpProjectId(options.projectId);
  if (!projectId) return undefined;

  const field = options.field ?? "errorId";
  const query = `jsonPayload.${field}="${errorId}"`;

  const params = [`query=${encodeURIComponent(query)}`];
  if (options.duration) {
    params.push(`duration=${encodeURIComponent(options.duration)}`);
  }

  return `https://console.cloud.google.com/logs/query;${params.join(
    ";",
  )}?project=${encodeURIComponent(projectId)}`;
}
