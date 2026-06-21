import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { z } from "zod";
import { appLogger } from "./app-error.js";
import type { Services } from "./services.js";

/**
 * Project base class for every useCase — extends the package's {@link UseCase}
 * (which injects `this.services` via the constructor) and adds a shared
 * `this.logger`. Subclasses still declare `static input` / `static output`.
 *
 * @example
 * ```ts
 * export class CreatePostUseCase extends AppUseCase<typeof input, typeof output> {
 *   static readonly input = input;
 *   static readonly output = output;
 *   async execute(payload) {
 *     this.logger.info("creating post", payload.id);
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
}
