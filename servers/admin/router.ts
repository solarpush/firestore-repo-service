/**
 * Minimal zero-dependency HTTP router for Firebase Functions.
 * Compatible with any Express-like (req, res) handler.
 *
 * Supports:
 *  - Named path parameters  (e.g. "/repos/:name/:id")
 *  - GET, POST, DELETE methods
 *  - Global middleware (before each route)
 *  - 404 / error fallbacks
 */

export type AnyReq = {
  method?: string;
  url?: string;
  /** Express originalUrl — preserved before any router stripping, contains the full path including the Firebase Functions prefix */
  originalUrl?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type AnyRes = {
  status: (code: number) => AnyRes;
  set: (key: string, value: string) => AnyRes;
  send: (body: string) => void;
  json: (body: unknown) => void;
  end: () => void;
};

export type RouteParams = Record<string, string>;

export type RouteHandler = (
  req: AnyReq & { params: RouteParams },
  res: AnyRes,
) => void | Promise<void>;

export type Middleware = (
  req: AnyReq & { params: RouteParams },
  res: AnyRes,
  next: () => void | Promise<void>,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const src = path
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ":" ? c : `\\${c}`))
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });

  return { pattern: new RegExp(`^${src}$`), paramNames };
}

function extractPath(req: AnyReq): string {
  const raw = req.path ?? req.url ?? "/";
  const idx = raw.indexOf("?");
  return idx === -1 ? raw : raw.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Router class
// ---------------------------------------------------------------------------

export class MiniRouter {
  private routes: CompiledRoute[] = [];
  private middlewares: Middleware[] = [];
  private notFoundHandler: RouteHandler = (_req, res) => {
    res.status(404).send("Not Found");
  };
  private errorHandler: (err: unknown, req: AnyReq, res: AnyRes) => void = (
    err,
    _req,
    res,
  ) => {
    console.error("[MiniRouter]", err);
    res.status(500).send("Internal Server Error");
  };

  // ── Route registration ────────────────────────────────────────────────────

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.addRoute("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.addRoute("POST", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.addRoute("DELETE", path, handler);
  }

  onNotFound(handler: RouteHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  onError(handler: (err: unknown, req: AnyReq, res: AnyRes) => void): this {
    this.errorHandler = handler;
    return this;
  }

  private addRoute(method: string, path: string, handler: RouteHandler): this {
    const { pattern, paramNames } = compilePath(path);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
    });
    return this;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async handle(req: AnyReq, res: AnyRes): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = extractPath(req);

    // Find matching route
    let matchedRoute: CompiledRoute | null = null;
    let params: RouteParams = {};

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) {
        matchedRoute = route;
        params = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? "");
        });
        break;
      }
    }

    const enrichedReq = Object.assign(req, { params });

    // Run middleware chain → then handler
    const handler = matchedRoute ? matchedRoute.handler : this.notFoundHandler;

    try {
      await this.runMiddlewareChain(enrichedReq, res, handler);
    } catch (err) {
      this.errorHandler(err, req, res);
    }
  }

  private async runMiddlewareChain(
    req: AnyReq & { params: RouteParams },
    res: AnyRes,
    finalHandler: RouteHandler,
  ): Promise<void> {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++]!;
        await mw(req, res, next);
      } else {
        await finalHandler(req, res);
      }
    };

    await next();
  }
}
