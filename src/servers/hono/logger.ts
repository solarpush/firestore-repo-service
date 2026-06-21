/**
 * `BaseLogger` — the package's ready-to-use {@link Logger}.
 *
 * Use it as-is (writes structured JSON to `console`), or extend it and override
 * the single {@link BaseLogger.write} hook to route to your sink (Firebase
 * `logger`, pino, Datadog, …). Each level funnels through `write`, so one
 * override covers them all.
 *
 * Pass an instance **per API** (`ApiConfig.logger`) or once via the registry
 * (`createApiRegistry({ services, logger })`); it is then injected into every
 * handler / interceptor / error-handler context as `logger`.
 *
 * @example
 * ```ts
 * import { logger as fnLogger } from "firebase-functions/v2";
 * class AppLogger extends BaseLogger {
 *   protected write(severity, payload) {
 *     fnLogger.write({ severity, ...payload });
 *   }
 * }
 * ```
 */

import type { Logger } from "./types";

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export class BaseLogger implements Logger {
  info(message: string, meta?: unknown): void {
    this.write("INFO", this.payload(message, meta));
  }

  warn(message: string, meta?: unknown): void {
    this.write("WARNING", this.payload(message, meta));
  }

  debug(message: string, meta?: unknown): void {
    this.write("DEBUG", this.payload(message, meta));
  }

  /**
   * Log an error and return a correlation id. If the error already carries an
   * `errorId` it is reused, otherwise a fresh one is generated.
   */
  error(error: unknown, meta?: unknown): string {
    const errorId = BaseLogger.errorId(error);
    this.write("ERROR", {
      errorId,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...(meta !== undefined ? { meta } : {}),
    });
    return errorId;
  }

  /** Build a structured payload from a message + optional metadata. */
  protected payload(message: string, meta?: unknown): Record<string, unknown> {
    return meta !== undefined ? { message, meta } : { message };
  }

  /**
   * Sink hook — override to route logs elsewhere. Default: structured
   * `console` write keyed by severity.
   */
  protected write(severity: LogSeverity, payload: Record<string, unknown>): void {
    const line = { severity, ...payload };
    // eslint-disable-next-line no-console
    if (severity === "ERROR") console.error(line);
    // eslint-disable-next-line no-console
    else if (severity === "WARNING") console.warn(line);
    // eslint-disable-next-line no-console
    else console.log(line);
  }

  /** Reuse an error's `errorId` when present, else generate one. */
  protected static errorId(error: unknown): string {
    if (
      error &&
      typeof error === "object" &&
      "errorId" in error &&
      typeof (error as { errorId: unknown }).errorId === "string"
    ) {
      return (error as { errorId: string }).errorId;
    }
    return Math.random().toString(36).slice(2, 12);
  }
}
