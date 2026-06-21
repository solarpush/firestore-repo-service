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
import type { AnyServicesContainer } from "./services";
import type { ErrorHandler, ErrorHandlerContext } from "./types";

export class BaseErrorHandler<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> implements ErrorHandler<TEnv, TServices>
{
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
