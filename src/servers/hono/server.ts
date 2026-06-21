/**
 * `HonoServer` — high-performance, fully-typed file-based API server for
 * Firebase Cloud Functions v2 (`onRequest`).
 *
 * Designed to:
 *  - rely on **prebuild codegen** (`hono:gen` CLI) for static imports → zero
 *    runtime filesystem scan, optimal cold-start;
 *  - expose handlers receiving a Zod-parsed payload typed end-to-end;
 *  - generate the OpenAPI 3.1 spec automatically from the same Zod schemas;
 *  - bridge Hono's Web Fetch API to Cloud Functions' Express-style
 *    `(req, res)` via `@hono/node-server`'s request listener.
 */

import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { z } from "zod";
import type { Env, MiddlewareHandler } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpsOptions } from "firebase-functions/v2/https";

import type {
  AnyRouteDef,
  ErrorHandler,
  HonoServerOptions,
  HttpMethod,
  InterceptorConfig,
  InterceptorOption,
  Logger,
  PayloadSource,
  RouteInterceptor,
} from "./types";
import {
  BadRequestError,
  defaultErrorResponse,
  OutputValidationError,
} from "./errors";
import { ValidationError } from "./types";
import { buildOpenApiDocument, renderDocsHtml } from "./openapi";
import { isDocsAuthExtension } from "./docs-auth";
import {
  createRequestContextMiddleware,
  type AnyServicesContainer,
} from "./services";

/**
 * Minimal shape of `firebase-functions/v2/https` `onRequest` so the package
 * stays decoupled from a specific firebase-functions version. We import the
 * real type only when users pass `onRequest` to `toFunction(...)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OnRequestFn = (...args: any[]) => any;

/**
 * Sentinel passed to handlers / interceptors when the server is started
 * without a `services` container. Frozen so accidental writes throw.
 */
const EMPTY_SERVICES: AnyServicesContainer = Object.freeze(
  {},
) as unknown as AnyServicesContainer;

export class HonoServer<TEnv extends Env = Env> {
  private readonly app: Hono<TEnv>;
  private readonly options: HonoServerOptions<TEnv>;
  private readonly mountedRoutes: AnyRouteDef[];
  private cachedSpec: Record<string, unknown> | null = null;

  constructor(options: HonoServerOptions<TEnv>) {
    this.options = options;
    this.app = new Hono<TEnv>();
    this.mountedRoutes = filterRoutes(options.routes, options.api);

    // Install the request-context middleware FIRST so the AsyncLocalStorage
    // is populated before any user middleware / handler runs.
    if (options.services) {
      this.app.use("*", createRequestContextMiddleware());
    }

    const globalMws = [
      ...(options.middlewares ?? []),
      ...(options.globalMiddlewares ?? []),
    ];
    for (const mw of globalMws) this.app.use("*", mw);

    this.mountRoutes();
    this.mountOpenApi();

    if (options.notFound) this.app.notFound(options.notFound);
    if (options.onError) this.app.onError(options.onError);
  }

  /** Underlying Hono instance — useful for advanced composition / tests. */
  get hono(): Hono<TEnv> {
    return this.app;
  }

  /** Raw `(req, res)` handler suitable for `onRequest()` / `http.createServer`. */
  get nodeHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return getRequestListener(this.app.fetch, {
      overrideGlobalObjects: false,
    });
  }

  /**
   * Wrap the server as a Cloud Functions v2 HTTP function.
   *
   * @param onRequest  The `onRequest` factory imported from
   *                   `firebase-functions/v2/https` (or `firebase-functions/https`).
   * @param httpsOptions  Options forwarded as the first argument to
   *                      `onRequest()` (region, memory, invoker, etc.).
   */
  toFunction(onRequest: OnRequestFn, httpsOptions?: HttpsOptions) {
    const handler = this.nodeHandler;
    if (httpsOptions) {
      return onRequest(httpsOptions, handler);
    }
    return onRequest(handler);
  }

  /** Generate (and cache) the OpenAPI 3.1 spec for the mounted routes. */
  buildOpenApiSpec(): Record<string, unknown> {
    if (this.cachedSpec) return this.cachedSpec;
    if (!this.options.openapi) {
      throw new Error("[HonoServer] openapi config not set");
    }
    this.cachedSpec = buildOpenApiDocument(
      this.mountedRoutes,
      this.options.basePath ?? "",
      this.options.openapi,
      interceptorConfig(this.options.interceptor as InterceptorOption | undefined),
    );
    return this.cachedSpec;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private mountRoutes(): void {
    const basePath = this.options.basePath ?? "";
    const validateOutput = this.options.validateOutput ?? false;
    const verbose = this.options.verbose ?? false;

    for (const route of this.mountedRoutes) {
      if (!route.path) {
        throw new Error(
          `[HonoServer] route "${route.method.toUpperCase()} (no path)" — missing \`path\`. ` +
            "Run the codegen so the path is derived from the file location, or set it explicitly.",
        );
      }

      const fullPath = joinPath(basePath, route.path);
      const middlewares = route.middlewares ?? [];
      const source: PayloadSource =
        route.source ?? (route.method === "get" ? "query" : "json");

      const handler = makeRouteHandler(
        route,
        source,
        validateOutput,
        interceptorFn(this.options.interceptor as InterceptorOption | undefined),
        this.options.services,
        this.options.errorHandler as ErrorHandler | undefined,
        this.options.logger as Logger | undefined,
      );
      const httpMethod = route.method.toUpperCase() as
        | "GET"
        | "POST"
        | "PUT"
        | "PATCH"
        | "DELETE";
      // `app.on(method, path, handlers[])` accepts a variadic array of
      // handlers/middlewares — the typed `.get/.post/...` overloads don't
      // accept a spread of generic `MiddlewareHandler[]`.
      this.app.on(
        httpMethod,
        [fullPath],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...([...middlewares, handler] as any[]),
      );

      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(
          `[HonoServer] ${route.method.toUpperCase().padEnd(6)} ${fullPath}`,
        );
      }
    }
  }

  private mountOpenApi(): void {
    const cfg = this.options.openapi;
    if (!cfg) return;
    const specPath = cfg.path ?? "/openapi.json";
    const docsPath = cfg.docsPath === undefined ? "/docs" : cfg.docsPath;
    const fullSpecPath = joinPath(this.options.basePath ?? "", specPath);
    const fullDocsPath =
      docsPath === false ? null : joinPath(this.options.basePath ?? "", docsPath);

    // Auth guards applied ONLY to the spec + docs endpoints (not API routes).
    // A DocsAuthExtension (e.g. firebaseDocsAuth) also contributes auxiliary
    // routes (login page / session / logout) mounted next to the docs.
    let guards: MiddlewareHandler[];
    if (isDocsAuthExtension(cfg.docsAuth)) {
      const ext = cfg.docsAuth;
      guards = [ext.middleware];
      // Mount the aux routes (unguarded) as siblings of the docs/spec page so
      // bare-name relative links/redirects stay correct behind any prefix.
      const authDir = dirOf(fullDocsPath ?? fullSpecPath);
      for (const route of ext.routes) {
        this.app.on(
          route.method,
          [joinPath(authDir, route.name)],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          route.handler as any,
        );
      }
    } else {
      guards = cfg.docsAuth
        ? Array.isArray(cfg.docsAuth)
          ? cfg.docsAuth
          : [cfg.docsAuth]
        : [];
    }

    this.app.on(
      "GET",
      [fullSpecPath],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...([...guards, (c: any) => c.json(this.buildOpenApiSpec())] as any[]),
    );

    if (fullDocsPath) {
      // Resolve the spec URL relative to the docs page so it works whether the
      // server is mounted at `/`, behind a Firebase Functions prefix
      // (`/<project>/<region>/<funcName>/...`), or behind any reverse proxy.
      const relativeSpecUrl = relativeUrlFromTo(fullDocsPath, fullSpecPath);
      this.app.on(
        "GET",
        [fullDocsPath],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...([
          ...guards,
          (c: any) => c.html(renderDocsHtml(relativeSpecUrl, cfg.info.title)),
        ] as any[]),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard distinguishing a structured interceptor from a bare function. */
function isInterceptorConfig(
  i: InterceptorOption | undefined,
): i is InterceptorConfig {
  return typeof i === "object" && i !== null && typeof i.handler === "function";
}

/** Extract the runtime interceptor function from either form. */
function interceptorFn(
  i: InterceptorOption | undefined,
): RouteInterceptor | undefined {
  if (!i) return undefined;
  return isInterceptorConfig(i) ? i.handler : i;
}

/** Extract the OpenAPI metadata (output/errors) from the structured form. */
function interceptorConfig(
  i: InterceptorOption | undefined,
): InterceptorConfig | undefined {
  return isInterceptorConfig(i) ? i : undefined;
}

function filterRoutes(
  routes: AnyRouteDef[],
  api: string | undefined,
): AnyRouteDef[] {
  if (!api) return routes.slice();
  return routes.filter((r) =>
    Array.isArray(r.api) ? r.api.includes(api) : r.api === api,
  );
}

function joinPath(base: string, path: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = path.startsWith("/") ? path : `/${path}`;
  const merged = `${left}${right}`;
  return merged === "" ? "/" : merged;
}

/** Directory of an absolute pathname, e.g. `/v1/docs` → `/v1`, `/docs` → ``. */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "" : path.slice(0, idx);
}

/**
 * Compute a URL relative to `from` that points to `to`, both being absolute
 * pathnames (e.g. `/v1/docs` → `/v1/openapi.json` becomes `openapi.json`).
 * Lets the OpenAPI UI fetch the spec without knowing the upstream prefix
 * added by Firebase Functions / reverse proxies.
 */
function relativeUrlFromTo(from: string, to: string): string {
  const fromSegs = from.split("/").filter(Boolean);
  const toSegs = to.split("/").filter(Boolean);
  // Drop the docs page filename so we resolve relative to its directory.
  fromSegs.pop();
  let common = 0;
  while (
    common < fromSegs.length &&
    common < toSegs.length &&
    fromSegs[common] === toSegs[common]
  ) {
    common++;
  }
  const ups = fromSegs.length - common;
  const rel = [
    ...Array(ups).fill(".."),
    ...toSegs.slice(common),
  ].join("/");
  return rel || "./";
}

/**
 * Build the actual Hono handler with input validation, output validation
 * (optional), and error normalisation.
 */
function makeRouteHandler(
  route: AnyRouteDef,
  source: PayloadSource,
  validateOutput: boolean,
  interceptor: RouteInterceptor | undefined,
  services: AnyServicesContainer | undefined,
  errorHandler: ErrorHandler | undefined,
  logger: Logger | undefined,
) {
  const inputSchema = route.input as z.ZodTypeAny | undefined;
  const outputSchema = route.output as z.ZodTypeAny | undefined;
  const status = route.status ?? 200;
  // Empty fallback so handlers/interceptors always see a `services` field
  // even when the server was started without a container.
  const servicesArg = (services ?? (EMPTY_SERVICES as AnyServicesContainer));

  return async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c: any,
  ): Promise<Response> => {
    // Apply the injected ErrorHandler, falling back to the built-in envelope.
    // Returns a Response when handled, or null to let the error propagate.
    const applyErrorHandler = async (err: unknown): Promise<Response | null> => {
      if (errorHandler) {
        const handled = await errorHandler.handle({
          error: err,
          c,
          route,
          services: servicesArg,
          logger,
        });
        if (handled) return handled;
      }
      return defaultErrorResponse(c, err);
    };

    // `next()` runs validation + handler. Any Zod failure throws
    // `ValidationError` so the interceptor (or default catcher) can shape it.
    const callNext = async (): Promise<unknown> => {
      let payload: unknown = undefined;

      if (inputSchema) {
        let raw: unknown;
        try {
          raw = await readPayload(c, source, route.method);
        } catch (err) {
          // Body parse failure → wrap as a generic Error so the interceptor
          // can decide. Use a 400-shaped Error subclass.
          throw new BadRequestError(
            err instanceof Error ? err.message : String(err),
          );
        }
        const parsed = inputSchema.safeParse(raw);
        if (!parsed.success) {
          throw new ValidationError(parsed.error, source);
        }
        payload = parsed.data;
      }

      const result = await (route.handler as (ctx: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        c: any;
        services: AnyServicesContainer;
        errorHandler: ErrorHandler | undefined;
        logger: Logger | undefined;
      }) => unknown)({
        input: payload,
        c,
        services: servicesArg,
        errorHandler,
        logger,
      });

      if (validateOutput && outputSchema && !(result instanceof Response)) {
        const checked = outputSchema.safeParse(result);
        if (!checked.success) {
          throw new OutputValidationError(checked.error);
        }
        return checked.data;
      }
      return result;
    };

    let result: unknown;
    if (interceptor) {
      // Interceptor owns the response shape — including validation errors.
      // If it rethrows, the injected ErrorHandler / default catcher applies.
      try {
        result = await interceptor({
          next: callNext,
          route,
          c,
          services: servicesArg,
          errorHandler,
          logger,
        });
      } catch (err) {
        const handled = await applyErrorHandler(err);
        if (handled) return handled;
        throw err;
      }
    } else {
      // Default behaviour — ErrorHandler first, then the built-in
      // ValidationError envelope, else bubble to onError / Hono.
      try {
        result = await callNext();
      } catch (err) {
        const handled = await applyErrorHandler(err);
        if (handled) return handled;
        throw err;
      }
    }

    if (result instanceof Response) return result;
    return c.json(result, status);
  };
}

async function readPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  source: PayloadSource,
  method: HttpMethod,
): Promise<unknown> {
  switch (source) {
    case "json": {
      if (method === "get") return c.req.query();
      const text = await c.req.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(
          `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    case "query":
      return c.req.query();
    case "form": {
      const form = await c.req.parseBody();
      return form;
    }
    case "param":
      return c.req.param();
    default:
      return {};
  }
}
