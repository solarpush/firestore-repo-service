/**
 * Public types for the Hono file-based API server.
 *
 * Designed to be:
 *  - **fully typed** end-to-end (Zod input/output → handler payload type),
 *  - **runtime-safe** via Zod parsing on every request,
 *  - **bundle-friendly** for Firebase Cloud Functions v2 cold-start (codegen
 *    emits static imports — no `fs`/`import()` at runtime).
 */

import type { z, ZodError } from "zod";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { AnyServicesContainer } from "./services";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Where the validated payload comes from. */
export type PayloadSource = "json" | "query" | "form" | "param";

/** Handler signature — receives a single typed context object. */
export type RouteHandler<
  TIn,
  TOut,
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> = (ctx: {
  /** Validated (and typed) request payload. `void` when no `input` schema is defined. */
  input: TIn;
  /** Raw Hono `Context` for headers, set status, redirect, etc. */
  c: Context<TEnv>;
  /**
   * Global DI services container — same instance shared by every handler.
   * Empty `ServicesContainer` when the server was started without a
   * `services` option.
   */
  services: TServices;
}) => Promise<TOut | Response> | TOut | Response;

/**
 * One route declaration. Default-exported by every `routes.ts` file inside the
 * domain tree. Use {@link defineRoute} for full type inference.
 */
export interface RouteDef<
  TIn extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TOut extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TEnv extends Env = Env,
> {
  /**
   * Logical API tag — routes sharing the same `api` are mounted on the same
   * `HonoServer` (typically one Cloud Function per `api`).
   *
   * To expose the **same logic** under several APIs with different
   * inputs/outputs, export multiple `defineRoute({...})` from the same file
   * (default + named exports are both picked up by the codegen).
   */
  api: string;

  /** HTTP method. */
  method: HttpMethod;

  /**
   * URL path appended to the server `basePath`. If omitted, the codegen will
   * derive it from the file location (e.g. `domains/activities/useCases/createCustom/routes.ts`
   * → `/activities/createCustom`).
   */
  path?: string;

  /**
   * Where the request payload comes from.
   * Default: `"json"` for body methods (POST/PUT/PATCH/DELETE), `"query"` for GET.
   */
  source?: PayloadSource;

  /** Zod schema validating the payload. Failures yield a 400 response. */
  input?: TIn;

  /**
   * Zod schema for the success response. Used to populate the OpenAPI spec
   * and (when `validateOutput` is enabled on the server) to assert the
   * runtime payload returned by the handler.
   */
  output?: TOut;

  /** Status code for the success response. Default: 200. */
  status?: number;

  /** Hono middlewares applied to this route only (after global middlewares). */
  middlewares?: MiddlewareHandler<TEnv>[];

  // ── OpenAPI metadata ─────────────────────────────────────────────────
  summary?: string;
  description?: string;
  tags?: string[];
  /** Mark the operation as deprecated in the generated spec. */
  deprecated?: boolean;
  /** Security requirements (operationId-level override). */
  security?: Array<Record<string, string[]>>;

  /** The request handler. */
  handler: RouteHandler<
    TIn extends z.ZodTypeAny ? z.infer<TIn> : void,
    TOut extends z.ZodTypeAny ? z.infer<TOut> : unknown,
    TEnv
  >;
}

/** Erased `RouteDef` used by registry/codegen — handler signature is opaque. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRouteDef = RouteDef<any, any>;

/**
 * What `routes.ts` can default-export:
 *  - a single {@link RouteDef} (most common case),
 *  - or an array of {@link RouteDef} (e.g. expose the same useCase on
 *    multiple `api` tags or under multiple paths).
 */
export type RouteModuleDefault = AnyRouteDef | AnyRouteDef[];

/**
 * Thrown by the server when the incoming request fails Zod validation.
 * Caught by the {@link RouteInterceptor} (if any) so users can shape the
 * response envelope however they like; otherwise yields a default 400.
 */
export class ValidationError extends Error {
  readonly statusCode = 400 as const;
  constructor(
    /** Original Zod error — `error.issues` to enumerate field-level problems. */
    readonly zodError: ZodError,
    /** Where the offending payload came from. */
    readonly source: PayloadSource,
  ) {
    super("Request validation failed");
    this.name = "ValidationError";
  }
}

/**
 * Cross-cutting interceptor applied around every handler.
 * Use it for response envelopes, business-error → HTTP mapping, structured
 * logging, tracing spans, etc.
 *
 * Wrap `next()` in `try/catch` to intercept BOTH Zod {@link ValidationError}s
 * (thrown before the handler runs) AND business errors thrown by the handler.
 *
 * @example
 * ```ts
 * interceptor: async ({ next, route, c }) => {
 *   try {
 *     const data = await next();
 *     return c.json({ success: true, data, error: null });
 *   } catch (err) {
 *     if (err instanceof ValidationError) {
 *       return c.json({ success: false, error: "validation", issues: err.zodError.issues }, 400);
 *     }
 *     if (err instanceof DomainError) {
 *       return c.json({ success: false, error: err.code }, err.statusCode);
 *     }
 *     throw err; // → falls back to onError or Hono's default 500
 *   }
 * }
 * ```
 */
export type RouteInterceptor<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> = (ctx: {
  /**
   * Calls validation + handler and returns the raw value.
   * Throws {@link ValidationError} on Zod failure or any error thrown by the handler.
   */
  next: () => Promise<unknown>;
  /** Route metadata (read-only). */
  route: AnyRouteDef;
  /** Hono request context. */
  c: Context<TEnv>;
  /** Global DI services container. See {@link RouteHandler}. */
  services: TServices;
}) => Promise<Response | unknown> | Response | unknown;

/** OpenAPI document info (subset of the spec used by the helper). */
export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

/** OpenAPI configuration on the server. */
export interface OpenAPIConfig {
  /** Path served by the JSON spec (e.g. `/openapi.json`). Default: `/openapi.json`. */
  path?: string;
  /** Path serving the documentation UI. Set to `false` to disable. Default: `/docs`. */
  docsPath?: string | false;
  /** OpenAPI document info. */
  info: OpenAPIInfo;
  /** Optional servers list for the spec. */
  servers?: { url: string; description?: string }[];
  /** Optional security schemes (e.g. bearer auth). */
  securitySchemes?: Record<string, unknown>;
  /** Default security requirement applied to every operation. */
  security?: Array<Record<string, string[]>>;
}

/** Options consumed by the {@link HonoServer} constructor. */
export interface HonoServerOptions<TEnv extends Env = Env> {
  /**
   * API tag — only routes whose `api` matches this value are mounted.
   * If omitted, every route in the registry is mounted.
   */
  api?: string;

  /** Pre-resolved route registry (typically the codegen output). */
  routes: AnyRouteDef[];

  /** URL prefix mounted before every route path. Default: `""`. */
  basePath?: string;

  /** Hono middlewares applied to every route (after the built-ins). */
  middlewares?: MiddlewareHandler<TEnv>[];

  /**
   * Alias for `middlewares` — global middlewares applied to every route.
   * If both are provided, `globalMiddlewares` is appended after `middlewares`.
   */
  globalMiddlewares?: MiddlewareHandler<TEnv>[];

  /**
   * If `true`, the server validates the value returned by every handler
   * against the route's `output` schema and rejects mismatches with a 500
   * response. Useful in dev / staging. Default: `false`.
   */
  validateOutput?: boolean;

  /** Enable verbose logging of mounted routes at startup. Default: `false`. */
  verbose?: boolean;

  /** OpenAPI configuration. Omit to disable. */
  openapi?: OpenAPIConfig;

  /** Custom 404 handler. */
  notFound?: (c: Context<TEnv>) => Response | Promise<Response>;

  /** Custom error handler. */
  onError?: (err: unknown, c: Context<TEnv>) => Response | Promise<Response>;

  /**
   * Cross-cutting interceptor wrapping every handler call.
   * Ideal for response envelopes, business-error mapping, tracing.
   * See {@link RouteInterceptor}.
   */
  interceptor?: RouteInterceptor<TEnv>;

  /**
   * Global DI services container (see {@link createServices}).
   *
   * When provided:
   *  - a middleware is installed automatically so the built-in `ctx`
   *    service resolves to the current request via `AsyncLocalStorage`;
   *  - `services` is passed into every handler and the interceptor.
   *
   * The same container instance should be shared across every API of your
   * project — declare it once and pass it to {@link createApiRegistry}.
   */
  services?: AnyServicesContainer;
}
