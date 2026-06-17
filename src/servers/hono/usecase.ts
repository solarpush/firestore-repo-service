/**
 * useCase ⇆ route bridge.
 *
 * A useCase owns its Zod `input` / `output` schemas (declared as `static`
 * members) and the business logic in {@link UseCase.execute}. Routes never
 * re-declare those schemas: they wire a useCase into an HTTP endpoint with the
 * one-liner {@link ApiRegistry.useCaseRoute} (or the standalone
 * {@link useCaseRoute}), keeping `routes.ts` flat and readable while the
 * types can never drift from the schemas.
 *
 * @example
 * ```ts
 * // useCase.ts — single source of truth for the I/O shape
 * import { z } from "zod";
 * import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
 * import type { Services } from "../../../../services.js";
 *
 * const input = z.object({ example: z.string() });
 * const output = z.object({ id: z.string(), warning: z.string().nullable() });
 *
 * export class CreatePostUseCase extends UseCase<typeof input, typeof output, Services> {
 *   static readonly input = input;
 *   static readonly output = output;
 *
 *   async execute(payload: z.infer<typeof input>): Promise<z.infer<typeof output>> {
 *     return { id: payload.example, warning: null };
 *   }
 * }
 *
 * // routes.ts — one line per route, `api` stays typed
 * export default defineRoutes([
 *   useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
 * ]);
 * ```
 */

import type { z } from "zod";

import type {
  HttpMethod,
  PayloadSource,
  RouteDef,
} from "./types";
import type { AnyServicesContainer } from "./services";

/**
 * Base class for every useCase — pure business logic, no HTTP awareness.
 * The shared {@link AnyServicesContainer} is injected via the constructor; the
 * `input` / `output` Zod schemas are declared as `static` members on the
 * concrete subclass (see {@link UseCaseClass}).
 *
 * @typeParam TInput   Zod schema of the validated request payload.
 * @typeParam TOutput  Zod schema of the success response.
 * @typeParam TServices Concrete services container injected into the useCase.
 */
export abstract class UseCase<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  constructor(protected readonly services: TServices) {}

  /** Run the business logic. Input is already validated against the schema. */
  abstract execute(input: z.infer<TInput>): Promise<z.infer<TOutput>>;
}

/**
 * Structural type of a concrete {@link UseCase} subclass — i.e. a constructor
 * that also exposes the `static input` / `static output` schemas. Consumed by
 * {@link useCaseRoute} to derive the route's Zod schemas and the handler types.
 */
export interface UseCaseClass<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  readonly input: TInput;
  readonly output: TOutput;
  new (services: TServices): UseCase<TInput, TOutput, TServices>;
}

/**
 * HTTP metadata for {@link useCaseRoute} — everything a route needs **except**
 * the input/output schemas and the handler, which are derived from the useCase.
 */
export interface UseCaseRouteMeta<TApi extends string = string> {
  /** API tag the route is mounted under. */
  api: TApi;
  /** HTTP method. */
  method: HttpMethod;
  /** URL path. Defaults to the codegen-derived path when omitted. */
  path?: string;
  /** Where the payload comes from. Defaults per method (see {@link RouteDef}). */
  source?: PayloadSource;
  /** Success status code. Default: 200. */
  status?: number;

  // ── OpenAPI metadata ─────────────────────────────────────────────────
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
}

/**
 * Build a {@link RouteDef} from a useCase class and HTTP metadata. The route's
 * `input` / `output` schemas are read from the useCase's `static` members and
 * the handler instantiates the useCase with the request `services` and runs
 * {@link UseCase.execute}.
 *
 * Prefer the registry-bound `apis.useCaseRoute` (returned by
 * `createApiRegistry`) so that `meta.api` is narrowed to the registered tags.
 */
export function useCaseRoute<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TServices extends AnyServicesContainer,
  TApi extends string = string,
>(
  useCaseClass: UseCaseClass<TInput, TOutput, TServices>,
  meta: UseCaseRouteMeta<TApi>,
): RouteDef<TInput, TOutput> & { api: TApi } {
  return {
    ...meta,
    input: useCaseClass.input,
    output: useCaseClass.output,
    handler: ({ input, services }) =>
      new useCaseClass(services as TServices).execute(
        input as z.infer<TInput>,
      ),
  } as RouteDef<TInput, TOutput> & { api: TApi };
}
