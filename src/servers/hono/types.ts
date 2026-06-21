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
import type { DocsAuthExtension } from "./docs-auth";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Where the validated payload comes from. */
export type PayloadSource = "json" | "query" | "form" | "param";

/**
 * Structured logger injected into every handler / interceptor / error-handler
 * context. Implement it, or extend the package's `BaseLogger` and override its
 * `write` hook to route to your sink (Firebase logger, pino, …).
 *
 * `error()` returns a correlation id so the same value can be both logged and
 * returned to the client.
 */
export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  /** @returns a correlation id (e.g. to include in the HTTP error response). */
  error(error: unknown, meta?: unknown): string;
  debug(message: string, meta?: unknown): void;
}

/** Context passed to {@link ErrorHandler.handle}. */
export interface ErrorHandlerContext<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  /** The thrown value (an `AppError`, a Zod {@link ValidationError}, …). */
  error: unknown;
  /** Hono request context — set status, read headers, build the response. */
  c: Context<TEnv>;
  /** Route metadata (read-only). */
  route: AnyRouteDef;
  /** Global DI services container. */
  services: TServices;
  /** Injected {@link Logger} when one was passed to the API, else `undefined`. */
  logger?: Logger;
}

/**
 * Cross-cutting error strategy — a class (or object) you pass to the API and
 * that the server injects everywhere **and** applies automatically.
 *
 * Implement {@link ErrorHandler.handle} to map any thrown value to an HTTP
 * `Response` (e.g. your `AppError` → status + localized body, plus structured
 * logging with a correlation id). Return `null` to decline the error and let
 * the built-in fallback (`ValidationError` envelope) / `onError` take over.
 *
 * Prefer extending the package's {@link BaseErrorHandler} (it already maps the
 * built-in errors) and overriding its `mapError` / `logError` hooks. Pass it
 * **per API** via `ApiConfig.errorHandler`, or once via the registry
 * (`{ services, errorHandler }`); it is then available in every handler /
 * interceptor context as `errorHandler` and auto-applied on any uncaught error.
 */
export interface ErrorHandler<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  handle(
    ctx: ErrorHandlerContext<TEnv, TServices>,
  ): Response | null | Promise<Response | null>;
}

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
  /**
   * Injected {@link ErrorHandler} when one was passed to the API, else
   * `undefined`. Usually you just `throw` and let it apply automatically.
   */
  errorHandler?: ErrorHandler<TEnv, TServices>;
  /** Injected {@link Logger} when one was passed to the API, else `undefined`. */
  logger?: Logger;
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
  security?: SecurityRequirement[];

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
 *    multiple `api` tags or under multiple paths). `readonly` arrays are
 *    accepted so that tuple-preserving helpers like {@link defineRoutes} (or a
 *    plain `as const` array) can be default-exported directly.
 */
export type RouteModuleDefault = AnyRouteDef | readonly AnyRouteDef[];

// ── useCase ⇆ routes type bridge ──────────────────────────────────────────
// A useCase should never re-declare its input/output by hand. Instead it
// derives them from the Zod schemas of the route(s) that drive it, so the two
// can never drift apart. Pass `typeof import("./routes.js").default` to the
// helpers below.

/**
 * Identity helper that **preserves the tuple type** of a `routes.ts` default
 * export. A plain array literal (`export default [a, b]`) collapses every
 * element to a single common type, which would lose each route's individual
 * schema. Wrapping the array with `defineRoutes([...])` keeps the per-route
 * types intact so {@link RouteInput} / {@link RouteOutput} can aggregate them
 * into a union.
 *
 * @example
 * export default defineRoutes([
 *   defineRoute({ ... }),
 *   defineRoute({ ... }),
 * ]);
 */
export function defineRoutes<const T extends readonly AnyRouteDef[]>(
  routes: T,
): T {
  return routes;
}

/**
 * Normalizes a `routes.ts` default export — a single {@link RouteDef} or an
 * array of them — to a *union* of its individual route members.
 */
export type RoutesUnion<T> = T extends readonly (infer R)[] ? R : T;

type InferRouteInput<R> = R extends { input?: infer I }
  ? I extends z.ZodTypeAny
    ? z.infer<I>
    : void
  : void;

type InferRouteOutput<R> = R extends { output?: infer O }
  ? O extends z.ZodTypeAny
    ? z.infer<O>
    : unknown
  : unknown;

/**
 * Union of validated request payloads across every route in a `routes.ts`
 * module. Use it to type a useCase input without duplicating the Zod schema:
 *
 * @example
 * type Routes = typeof import("./routes.js").default;
 * export type CreatePostUseCaseInput = RouteInput<Routes>;
 */
export type RouteInput<T> = InferRouteInput<RoutesUnion<T>>;

/**
 * Union of success-response payloads across every route in a `routes.ts`
 * module. Mirror of {@link RouteInput} for the useCase output type.
 */
export type RouteOutput<T> = InferRouteOutput<RoutesUnion<T>>;

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
  /**
   * Injected {@link ErrorHandler} when one was passed to the API. Call
   * `errorHandler?.handle({ error, c, route, services })` in your `catch` to
   * reuse the shared mapping, or simply rethrow to let it apply automatically.
   */
  errorHandler?: ErrorHandler<TEnv, TServices>;
  /** Injected {@link Logger} when one was passed to the API, else `undefined`. */
  logger?: Logger;
}) => Promise<Response | unknown> | Response | unknown;

/**
 * Success-envelope schema declared alongside an interceptor so the generated
 * OpenAPI spec documents what the **wrapper actually returns** (not the raw
 * handler output).
 *
 * - a **static** Zod schema → same envelope for every route (e.g.
 *   `z.object({ data: z.any(), intercepted: z.boolean() })`);
 * - a **factory** `(routeOutput) => schema` → wraps each route's own `output`,
 *   so `data` is typed per endpoint in the docs.
 */
export type InterceptorOutput =
  | z.ZodTypeAny
  | ((routeOutput: z.ZodTypeAny | undefined) => z.ZodTypeAny);

/** A single declared error response for the OpenAPI spec. */
export type InterceptorErrorResponse =
  | z.ZodTypeAny
  | { description?: string; schema?: z.ZodTypeAny };

/**
 * Structured interceptor — pairs the cross-cutting {@link RouteInterceptor}
 * `handler` with the OpenAPI metadata describing what it returns, so the docs
 * reflect the real wrapped responses (success envelope + error shapes).
 *
 * @example
 * ```ts
 * interceptor: {
 *   // factory: `data` reflects each route's own output schema
 *   output: (routeOutput) =>
 *     z.object({ data: routeOutput ?? z.unknown(), intercepted: z.boolean() }),
 *   errors: {
 *     400: ValidationErrorSchema,
 *     500: { description: "Internal", schema: ErrorSchema },
 *   },
 *   handler: async ({ c, next }) => {
 *     const data = await next();
 *     return c.json({ data, intercepted: true });
 *   },
 * }
 * ```
 */
export interface InterceptorConfig<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  /** Success-envelope schema (static) or per-route factory. */
  output?: InterceptorOutput;
  /**
   * Error responses applied to **every** operation, keyed by HTTP status. Pass
   * a bare Zod schema or `{ description, schema }`.
   */
  errors?: Record<number, InterceptorErrorResponse>;
  /** The interceptor function. See {@link RouteInterceptor}. */
  handler: RouteInterceptor<TEnv, TServices>;
}

/**
 * Interceptor option accepted by the server / registry — either a bare
 * {@link RouteInterceptor} function (legacy) or a structured
 * {@link InterceptorConfig} carrying OpenAPI metadata.
 */
export type InterceptorOption<
  TEnv extends Env = Env,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> = RouteInterceptor<TEnv, TServices> | InterceptorConfig<TEnv, TServices>;

/** OpenAPI document info (subset of the spec used by the helper). */
export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

// ── OpenAPI 3.1 Security Scheme Object ──────────────────────────────────────

/** Fields shared by every security scheme. */
export interface SecuritySchemeBase {
  /** Human-readable description (CommonMark). */
  description?: string;
}

/** API key carried in a header, query param or cookie. */
export interface ApiKeySecurityScheme extends SecuritySchemeBase {
  type: "apiKey";
  /** Name of the header, query parameter or cookie. */
  name: string;
  /** Location of the API key. */
  in: "query" | "header" | "cookie";
}

/**
 * HTTP authentication (RFC 7235), e.g. `bearer` (Firebase ID tokens) or
 * `basic`.
 */
export interface HttpSecurityScheme extends SecuritySchemeBase {
  type: "http";
  /** Auth scheme name — `"bearer"`, `"basic"`, `"digest"`, … */
  // eslint-disable-next-line @typescript-eslint/ban-types
  scheme: "bearer" | "basic" | "digest" | (string & {});
  /** Hint for the bearer token format, e.g. `"JWT"` / `"Firebase JWT"`. */
  bearerFormat?: string;
}

/** Mutual TLS authentication. */
export interface MutualTlsSecurityScheme extends SecuritySchemeBase {
  type: "mutualTLS";
}

/** A single OAuth2 flow. */
export interface OAuthFlowObject {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  /** Available scopes → description. */
  scopes: Record<string, string>;
}

/** The OAuth2 flows supported by an {@link OAuth2SecurityScheme}. */
export interface OAuthFlowsObject {
  implicit?: OAuthFlowObject;
  password?: OAuthFlowObject;
  clientCredentials?: OAuthFlowObject;
  authorizationCode?: OAuthFlowObject;
}

/** OAuth2 authentication. */
export interface OAuth2SecurityScheme extends SecuritySchemeBase {
  type: "oauth2";
  flows: OAuthFlowsObject;
}

/** OpenID Connect Discovery. */
export interface OpenIdConnectSecurityScheme extends SecuritySchemeBase {
  type: "openIdConnect";
  openIdConnectUrl: string;
}

/** OpenAPI 3.1 Security Scheme Object (discriminated on `type`). */
export type SecurityScheme =
  | ApiKeySecurityScheme
  | HttpSecurityScheme
  | MutualTlsSecurityScheme
  | OAuth2SecurityScheme
  | OpenIdConnectSecurityScheme;

/**
 * A single Security Requirement Object: maps a scheme name (a key of
 * {@link OpenAPIConfig.securitySchemes}) to the list of required scopes
 * (empty `[]` for `http` / `apiKey`).
 */
export type SecurityRequirement = Record<string, string[]>;

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
  /**
   * Reusable security schemes, keyed by name. The keys are referenced from
   * {@link OpenAPIConfig.security} / per-route `security`.
   *
   * @example
   * ```ts
   * securitySchemes: {
   *   bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Firebase JWT" },
   * }
   * ```
   */
  securitySchemes?: Record<string, SecurityScheme>;
  /**
   * Default security requirement applied to every operation. Each entry maps a
   * scheme name (a key of {@link OpenAPIConfig.securitySchemes}) to its scopes.
   *
   * @example `security: [{ bearerAuth: [] }]`
   */
  security?: SecurityRequirement[];
  /**
   * Hono middleware(s) guarding **only** the docs UI and JSON spec endpoints
   * (not the API routes). Use a raw middleware for a custom flow, or the
   * built-in {@link firebaseBearerAuth} / {@link basicAuth} helpers.
   *
   * @example
   * ```ts
   * import { firebaseBearerAuth } from "@lpdjs/firestore-repo-service/servers/hono";
   * openapi: { info, docsAuth: firebaseBearerAuth({ getAuth }) }
   * ```
   *
   * For a full login form + session cookie (like the admin server), pass the
   * {@link DocsAuthExtension} returned by `firebaseDocsAuth({ ... })` instead.
   */
  docsAuth?: MiddlewareHandler | MiddlewareHandler[] | DocsAuthExtension;
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
   *
   * Pass a bare {@link RouteInterceptor} function, or an
   * {@link InterceptorConfig} (`{ output?, errors?, handler }`) so the
   * generated OpenAPI spec documents the wrapped responses.
   */
  interceptor?: InterceptorOption<TEnv>;

  /**
   * Cross-cutting error strategy applied to every uncaught error and injected
   * into every handler / interceptor context. See {@link ErrorHandler}.
   *
   * Typically shared across APIs — pass it once to `createApiRegistry` via
   * `{ services, errorHandler }`; this per-API field overrides it.
   */
  errorHandler?: ErrorHandler<TEnv>;

  /**
   * Structured {@link Logger} injected into every handler / interceptor /
   * error-handler context. Extend the package's `BaseLogger` to route to your
   * sink. Typically shared via `createApiRegistry({ services, logger })`; this
   * per-API field overrides it.
   */
  logger?: Logger;

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
