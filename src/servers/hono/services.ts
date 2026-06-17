/**
 * Global DI services container for the Hono server.
 *
 * Lets you declare all your singletons (repositories, SDK clients, useCases,
 * loggers…) **once**, then inject them anywhere — routes, interceptors,
 * cron jobs, Firestore triggers, tests.
 *
 * ## How it works
 *
 *  - Each service is constructed **lazily** on first access and cached for
 *    the process lifetime (perfect for Cloud Functions cold-start).
 *  - Providers may be **classes** (auto-injected: `new Class(services)`)
 *    or **factories** (`(services) => instance`). Mix both freely.
 *  - Inter-service dependencies are inferred either by destructuring the
 *    factory argument (`postRepo: ({ db }) => new PostRepo(db)`) or by
 *    reading `this.services.*` inside a class.
 *  - A built-in `ctx` service exposes the **current request's** Hono
 *    `Context` via `AsyncLocalStorage`. UseCases access
 *    `this.services.ctx.c.get("user")` without any plumbing.
 *  - Cycles are detected at first access with a clear error.
 *
 * @example
 * ```ts
 * // src/services.ts — infrastructure singletons only (no useCases here)
 * import { createServices } from "@lpdjs/firestore-repo-service/servers/hono";
 * import { PostRepo } from "./domains/posts/PostRepo.js";
 * import { Mailer } from "./services/Mailer.js";
 *
 * export const services = createServices({
 *   postRepo: PostRepo,           // class form (auto-injected)
 *   mailer: ({ ctx }) => new Mailer(ctx), // factory form
 * });
 *
 * export type Services = typeof services;
 * ```
 *
 * @example
 * ```ts
 * // src/apis.ts
 * import { services } from "./services.js";
 * export const apis = createApiRegistry(
 *   { v1: { basePath: "/v1", ... } },
 *   { services },
 * );
 * ```
 *
 * @example
 * ```ts
 * // Inside a useCase — extends the UseCase base, owns its Zod schemas
 * import { z } from "zod";
 * import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
 * import type { Services } from "../../services.js";
 *
 * const input = z.object({ title: z.string() });
 * const output = z.object({ id: z.string() });
 *
 * export class CreatePostUseCase extends UseCase<typeof input, typeof output, Services> {
 *   static readonly input = input;
 *   static readonly output = output;
 *
 *   async execute(payload: z.infer<typeof input>): Promise<z.infer<typeof output>> {
 *     const user = this.services.ctx.c.get("user");
 *     return this.services.postRepo.create({ ...payload, authorId: user.id });
 *   }
 * }
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Env, MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Request-scoped context (AsyncLocalStorage backed)
// ---------------------------------------------------------------------------

/**
 * Per-request context exposed to every service / useCase.
 * The instance is a **stable singleton** but its `c` getter resolves to the
 * Hono `Context` of the currently-handled request via `AsyncLocalStorage`.
 *
 * Outside of a request (cron, manual scripts, tests), wrap your call in
 * {@link withRequestContext} to supply a context, otherwise accessing `c`
 * will throw.
 */
export interface RequestContext<TEnv extends Env = Env> {
  /** Hono `Context` of the currently-handled request. */
  readonly c: Context<TEnv>;
  /**
   * Same as `c` but returns `undefined` instead of throwing when called
   * outside a request scope. Useful for opportunistic logging.
   */
  readonly maybeC: Context<TEnv> | undefined;
}

interface RequestStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>;
}

const als = new AsyncLocalStorage<RequestStore>();

const requestContextSingleton: RequestContext = Object.freeze({
  get c() {
    const store = als.getStore();
    if (!store) {
      throw new Error(
        "[services] requestContext.c was accessed outside of a request. " +
          "Wrap non-HTTP code paths (cron, triggers, scripts, tests) in " +
          "`withRequestContext({ c }, () => ...)` to supply a Hono Context.",
      );
    }
    return store.c;
  },
  get maybeC() {
    return als.getStore()?.c;
  },
});

/**
 * Hono middleware installed automatically by `HonoServer` when a `services`
 * container is provided. Populates the AsyncLocalStorage so the built-in
 * `ctx` service resolves to the current request.
 *
 * Exported for advanced cases (custom server / non-Hono adapter); you do not
 * need to call this manually in the standard flow.
 */
export function createRequestContextMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await als.run({ c }, async () => {
      await next();
    });
  };
}

/**
 * Run `fn` with a synthetic request context — required when invoking
 * services outside an HTTP handler (cron jobs, Firestore triggers, scripts,
 * unit tests). Inside `fn`, `services.ctx.c` resolves to the supplied `c`.
 *
 * @example
 * ```ts
 * // A cron that reuses a useCase
 * export const dailyTask = onSchedule("every 24 hours", async () => {
 *   await withRequestContext({ c: fakeContext() }, async () => {
 *     await services.createPostUseCase.execute({ ... });
 *   });
 * });
 * ```
 */
export function withRequestContext<T>(
  ctx: { c: Context },
  fn: () => Promise<T> | T,
): Promise<T> {
  return als.run({ c: ctx.c }, async () => fn());
}

// ---------------------------------------------------------------------------
// createServices
// ---------------------------------------------------------------------------

/**
 * Reserved service name — the built-in request context. User factories
 * cannot override it.
 */
const CTX_KEY = "ctx" as const;

/**
 * Helper that derives the public services type from an output map.
 * Each entry in `TMap` is the instance type returned by its provider.
 * The built-in `ctx` is always present.
 */
export type ServicesOf<TMap> = { readonly ctx: RequestContext } & {
  readonly [K in keyof TMap]: TMap[K];
};

/**
 * A single provider entry — either a factory `(deps) => R` or a class
 * `new (deps) => R`. `deps` is the *complete* services proxy
 * (siblings + built-in `ctx`).
 */
export type ServiceProvider<TMap, R> =
  | ((deps: ServicesOf<TMap>) => R)
  | (new (deps: ServicesOf<TMap>) => R);

/**
 * A provider map — each value is either a factory or a class constructor.
 */
export type ServiceProviderMap<TMap> = {
  [K in keyof TMap]: K extends typeof CTX_KEY
    ? never
    : ServiceProvider<TMap, TMap[K]>;
};

/**
 * Extract the instance/return type from a single provider value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderReturn<P> = P extends new (...args: any) => infer R
  ? R
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    P extends (...args: any) => infer R
    ? R
    : never;

/**
 * Compute the output service map from an inferred provider map.
 */
export type MapFromProviders<P> = {
  [K in keyof P]: ProviderReturn<P[K]>;
};

/**
 * Container returned by {@link createServices}. Behaves like a plain object
 * keyed by service name — accessing a key triggers lazy instantiation.
 * Use `type Services = typeof services` to derive the public type.
 */
export type ServicesContainer<TMap> = TMap;

/**
 * Build a lazy singleton DI container.
 *
 * @param providers  A map of service name → factory function **or** class
 *                   constructor. The single argument (factory deps / first
 *                   ctor param) receives a deps proxy typed as the full
 *                   services map (siblings + the built-in `ctx`).
 *
 * @example Factory form
 * ```ts
 * db: () => getFirestore(),
 * postRepo: ({ db }) => new PostRepo(db),
 * ```
 *
 * @example Class form (zero-boilerplate auto-injection)
 * ```ts
 * class RepositoryService {
 *   constructor(private readonly services: Services) {}
 *   get posts() { return this.services.db.posts; }
 * }
 *
 * createServices({
 *   db: () => getFirestore(),    // ← factory
 *   repository: RepositoryService, // ← bare class (deps auto-injected)
 * });
 * ```
 */
export function createServices<
  P extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((deps: any) => unknown) | (new (deps: any) => unknown)
  >,
>(providers: P): ServicesContainer<ServicesOf<MapFromProviders<P>>> {
  const cache = new Map<string, unknown>();
  const inProgress: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy = new Proxy({} as any, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === CTX_KEY) return requestContextSingleton;

      if (cache.has(prop)) return cache.get(prop);

      const provider = (providers as Record<string, unknown>)[prop];
      if (typeof provider !== "function") {
        throw new Error(
          `[services] unknown service "${prop}". Registered: ${
            [CTX_KEY, ...Object.keys(providers)].join(", ")
          }`,
        );
      }

      if (inProgress.includes(prop)) {
        throw new Error(
          `[services] circular dependency detected: ${[
            ...inProgress,
            prop,
          ].join(" → ")}`,
        );
      }

      inProgress.push(prop);
      try {
        const value = isClassConstructor(provider)
          ? new (provider as new (deps: unknown) => unknown)(proxy)
          : (provider as (deps: unknown) => unknown)(proxy);
        cache.set(prop, value);
        return value;
      } finally {
        inProgress.pop();
      }
    },
    has(_target, prop) {
      if (typeof prop !== "string") return false;
      return prop === CTX_KEY || prop in providers;
    },
    ownKeys() {
      return [CTX_KEY, ...Object.keys(providers)];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === CTX_KEY || prop in providers) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
  });

    return proxy as ServicesContainer<ServicesOf<MapFromProviders<P>>>;
}

/**
 * Detect whether a function value should be invoked with `new` (class
 * constructor) or called directly (plain factory). Relies on the `class`
 * keyword being preserved in `Function.prototype.toString`, which is the
 * case for TypeScript / esbuild output targeting modern JS (ES2015+).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
function isClassConstructor(fn: Function): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn));
}

/**
 * Opaque container type used by registry / server signatures that don't
 * need to know the concrete services map.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyServicesContainer = ServicesContainer<Record<string, any>>;
