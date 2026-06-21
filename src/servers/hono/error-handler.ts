/**
 * `BaseErrorHandler` — the package's ready-to-use {@link ErrorHandler}.
 *
 * Use it as-is for an API that only needs the built-in error mapping
 * (`ValidationError` / `BadRequestError` / `OutputValidationError`), or extend
 * it and override the two hooks to plug your own domain errors + logger:
 *
 * - {@link BaseErrorHandler.mapError} — map your `AppError` → `Response`
 *   (return `null` to defer to the built-in mapping);
 * - {@link BaseErrorHandler.logError} — log via your `AppLogger`.
 *
 * Pass an instance **per API** (`ApiConfig.errorHandler`) so different APIs can
 * use different strategies (e.g. one with user-facing localized errors, one
 * with just the defaults).
 *
 * @example
 * ```ts
 * class AppErrorHandler extends BaseErrorHandler {
 *   protected mapError({ error, c }) {
 *     if (error instanceof AppError) {
 *       return c.json({ error: error.message, errorId: error.errorId }, error.statusCode);
 *     }
 *     return null; // → built-in mapping
 *   }
 *   protected logError({ error }) {
 *     AppLogger.err(error);
 *   }
 * }
 *
 * // apis.ts
 * v1: { ..., errorHandler: new AppErrorHandler() },  // user-facing API
 * v2: { ..., errorHandler: new BaseErrorHandler() }, // defaults only
 * ```
 */

import type { Env } from "hono";
import { defaultErrorResponse } from "./errors";
import {
  gcpLogsUrl,
  type GcpLogsLinkOptions,
} from "./gcp-logs";
import type { AnyServicesContainer } from "./services";
import type { ErrorHandler, ErrorHandlerContext } from "./types";

/** Construction options shared by every {@link BaseErrorHandler}. */
export interface BaseErrorHandlerOptions {
  /**
   * Enable building a GCP Logs Explorer deep link from an error's correlation
   * id (see {@link BaseErrorHandler.gcpLogsUrl}). Disabled by default — turn it
   * on in dev/staging to let engineers jump from a response to its log.
   */
  gcpLogs?: GcpLogsLinkOptions;
}

export class BaseErrorHandler<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> implements ErrorHandler<TEnv, TServices>
{
  constructor(protected readonly options: BaseErrorHandlerOptions = {}) {}

  /**
   * Build a GCP Logs Explorer link for `errorId`, or `undefined` when the
   * `gcpLogs` option is disabled / unresolved. Spread it into a mapped
   * response to give developers a one-click jump to the matching log:
   *
   * ```ts
   * const logsUrl = this.gcpLogsUrl(error.errorId);
   * return c.json({ error, errorId, ...(logsUrl ? { logsUrl } : {}) }, status);
   * ```
   */
  protected gcpLogsUrl(errorId?: string): string | undefined {
    return gcpLogsUrl(errorId, this.options.gcpLogs);
  }

  /**
   * Orchestration — not meant to be overridden. Tries the user mapping first,
   * logs it when matched, then falls back to the built-in mapping.
   */
  async handle(
    ctx: ErrorHandlerContext<TEnv, TServices>,
  ): Promise<Response | null> {
    const mapped = await this.mapError(ctx);
    if (mapped) {
      this.logError(ctx, mapped);
      return mapped;
    }
    return this.handleBuiltin(ctx);
  }

  /**
   * Map a domain error (your `AppError`) to a `Response`. Return `null` to let
   * {@link BaseErrorHandler.handleBuiltin} handle it. Default: `null`.
   */
  protected mapError(
    _ctx: ErrorHandlerContext<TEnv, TServices>,
  ): Response | null | Promise<Response | null> {
    return null;
  }

  /**
   * Log a mapped error (e.g. via your `AppLogger`). Called only when
   * {@link BaseErrorHandler.mapError} produced a response. Default: no-op.
   */
  protected logError(
    _ctx: ErrorHandlerContext<TEnv, TServices>,
    _response: Response,
  ): void {}

  /**
   * Built-in mapping of the package's own errors (`ValidationError`,
   * `BadRequestError`, `OutputValidationError`). Returns `null` for unknown
   * errors so they bubble to `onError` / Hono.
   */
  protected handleBuiltin(
    ctx: ErrorHandlerContext<TEnv, TServices>,
  ): Response | null {
    return defaultErrorResponse(ctx.c, ctx.error);
  }
}
