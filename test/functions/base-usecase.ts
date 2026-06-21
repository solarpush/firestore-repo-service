import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { z } from "zod";
import { AppError, appLogger } from "./app-error.js";
import type { Services } from "./services.js";

/**
 * Project base class for every useCase — extends the package's {@link UseCase}
 * (which injects `this.services` via the constructor) and adds two shared
 * ergonomics: `this.logger` (structured logger) and `this.error` (the
 * {@link AppError} factory, mapped to HTTP by the `AppErrorHandler`).
 * Subclasses still declare `static input` / `static output`.
 *
 * @example
 * ```ts
 * export class CreatePostUseCase extends AppUseCase<typeof input, typeof output> {
 *   static readonly input = input;
 *   static readonly output = output;
 *   async execute(payload) {
 *     this.logger.info("creating post", payload.id);
 *     if (!payload.id) throw this.error.badRequest("id is required");
 *     return { id: payload.id };
 *   }
 * }
 * ```
 */
export abstract class AppUseCase<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> extends UseCase<TInput, TOutput, Services> {
  /** Shared structured logger instance (same one injected per-API). */
  protected readonly logger = appLogger;

  /**
   * Domain error factory — `throw this.error.notFound(...)` /
   * `this.error.badRequest(...)` / `this.error.userMessage(...)`. The thrown
   * {@link AppError} is mapped to an HTTP response by the `AppErrorHandler`.
   */
  protected readonly error = AppError;
}
