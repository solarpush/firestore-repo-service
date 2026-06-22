/**
 * Typed multi-API registry.
 *
 * Lets you declare every API tag (= every Cloud Function) in **one place**,
 * with full TypeScript safety: the `api` field of {@link defineRoute} is
 * narrowed to the registered tags, and {@link toFunctions} returns one
 * `onRequest` Cloud Function per tag, named after its key.
 *
 * @example
 * ```ts
 * // apis.ts
 * import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
 * import { enrichUser } from "./middlewares/enrich-user.js";
 *
 * export const apis = createApiRegistry({
 *   v1: {
 *     basePath: "/v1",
 *     middlewares: [enrichUser],
 *     openapi: { info: { title: "Public API", version: "1.0.0" } },
 *   },
 *   webhooks: {
 *     basePath: "/hooks",
 *     openapi: { info: { title: "Webhooks", version: "1.0.0" } },
 *   },
 * });
 *
 * // Use in routes — `api` is now typed "v1" | "webhooks".
 * export const defineRoute = apis.defineRoute;
 * export const useCaseRoute = apis.useCaseRoute;
 *
 * // index.ts (Cloud Functions entrypoint)
 * import { onRequest } from "firebase-functions/v2/https";
 * import { apis } from "./apis.js";
 * import { routes } from "./domains/__generated__/routes.js";
 *
 * export const { v1, webhooks } = apis.toFunctions(routes, onRequest, {
 *   defaults: { region: "us-central1", invoker: "public" },
 *   per: { v1: { memory: "512MiB" } },
 * });
 * // → URLs:  https://<region>-<project>.cloudfunctions.net/v1/posts
 * //          https://<region>-<project>.cloudfunctions.net/webhooks/...
 * ```
 */

import type { Env } from "hono";
import type { z } from "zod";
import type { HttpsOptions } from "firebase-functions/v2/https";

import type {
  AnyRouteDef,
  ErrorHandler,
  HonoServerOptions,
  Logger,
  RouteDef,
  RouteHandler,
} from "./types";
import { HonoServer } from "./server";
import type { AnyServicesContainer } from "./services";
import {
  useCaseRoute as buildUseCaseRoute,
  type UseCaseClass,
  type UseCaseRouteMeta,
} from "./usecase";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OnRequestFn = (...args: any[]) => any;

/**
 * Per-API configuration. Same shape as {@link HonoServerOptions} minus the
 * `routes` (resolved by the registry), `api` (the registry key) and
 * `services` (set globally on the registry — see
 * {@link createApiRegistry}).
 */
export type ApiConfig<TEnv extends Env = Env> = Omit<
  HonoServerOptions<TEnv>,
  "routes" | "api" | "services"
>;

/** Map of API tag → its config. */
export type ApiConfigMap = Record<string, ApiConfig>;

/**
 * Per-key excess-property guard.
 *
 * `createApiRegistry` infers its config map generically (`<const TMap …>`),
 * which normally **defeats** TypeScript's excess-property checking — a typo
 * like `openApi` or `middleware` (instead of `openapi` / `middlewares`) would
 * pass silently and the option would be ignored at runtime.
 *
 * This intersects the concrete {@link ApiConfig} shape (so every known key
 * keeps its real type **and JSDoc**, including nested objects such as
 * `openapi`) with a `never` mapping for any key absent from `ApiConfig` — which
 * makes typos a compile error, matching the strictness already enforced on the
 * CRUD server's `openapi`.
 *
 * @internal
 */
export type StrictApiConfig<T, TEnv extends Env = Env> = ApiConfig<TEnv> & {
  [K in keyof T as K extends keyof ApiConfig<TEnv> ? never : K]: never;
};

/**
 * Options accepted by {@link createApiRegistry} alongside the per-API
 * configs.
 */
export interface ApiRegistryOptions<
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  /**
   * Global DI services container shared across every API. See
   * {@link ServicesContainer} / `createServices`. When provided, every
   * `HonoServer` mounted by the registry receives it and exposes
   * `services` to every handler / interceptor.
   */
  services?: TServices;

  /**
   * Cross-cutting {@link ErrorHandler} shared across every API — injected into
   * every handler / interceptor context and applied automatically on any
   * uncaught error. A per-API `errorHandler` (on the config) overrides it.
   */
  errorHandler?: ErrorHandler;

  /**
   * Structured {@link Logger} shared across every API — injected into every
   * handler / interceptor / error-handler context. A per-API `logger` (on the
   * config) overrides it.
   */
  logger?: Logger;
}

export interface ApiRegistry<
  TMap extends ApiConfigMap,
  TServices extends AnyServicesContainer = AnyServicesContainer,
> {
  /** The registered configs (read-only). */
  readonly configs: TMap;

  /**
   * Typed `defineRoute` — the `api` field is constrained to `keyof TMap`,
   * and `handler({ services })` is typed with the concrete services
   * container passed to {@link createApiRegistry}.
   */
  defineRoute<
    TIn extends z.ZodTypeAny | undefined = undefined,
    TOut extends z.ZodTypeAny | undefined = undefined,
  >(
    def: Omit<RouteDef<TIn, TOut>, "api" | "handler"> & {
      api: keyof TMap & string;
      handler: RouteHandler<
        TIn extends z.ZodTypeAny ? z.infer<TIn> : void,
        TOut extends z.ZodTypeAny ? z.infer<TOut> : unknown,
        Env,
        TServices
      >;
    },
  ): RouteDef<TIn, TOut> & { api: keyof TMap & string };

  /**
   * Typed `useCaseRoute` — wires a {@link UseCase} class into a route in one
   * line. The route's `input` / `output` schemas are read from the useCase's
   * `static` members and the handler instantiates it with the request
   * `services`. The `api` field is constrained to `keyof TMap`.
   *
   * @example
   * export default defineRoutes([
   *   useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
   * ]);
   */
  useCaseRoute<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny>(
    useCaseClass: UseCaseClass<TIn, TOut, TServices>,
    meta: UseCaseRouteMeta<keyof TMap & string>,
  ): RouteDef<TIn, TOut> & { api: keyof TMap & string };

  /**
   * Build one Cloud Function per registered API and return them as a map
   * keyed by API tag — spread it directly into your `index.ts` exports.
   *
   * @param routes Pre-resolved route registry (typically the codegen output).
   * @param onRequest The `onRequest` factory imported from
   *                  `firebase-functions/v2/https`.
   * @param opts Optional defaults and per-API overrides for `httpsOptions`.
   */
  toFunctions(
    routes: AnyRouteDef[],
    onRequest: OnRequestFn,
    opts?: {
      /** Shared `HttpsOptions` applied to every generated function. */
      defaults?: HttpsOptions;
      /** Per-API overrides — merged on top of {@link defaults}. */
      per?: Partial<Record<keyof TMap & string, HttpsOptions>>;
    },
  ): { [K in keyof TMap & string]: ReturnType<OnRequestFn> };

  /** Build the underlying {@link HonoServer} for a given API (escape hatch). */
  serverFor<K extends keyof TMap & string>(
    api: K,
    routes: AnyRouteDef[],
  ): HonoServer;

  /**
   * Build the OpenAPI 3.1 document for a given API **statically** (no server
   * boot / no network) — symmetric with the CRUD server's `.spec()`. Handy for
   * a build-time export consumed by an SDK generator:
   *
   * ```ts
   * // export-openapi.ts
   * import { apis } from "./apis.js";
   * import { routes } from "./domains/__generated__/routes.js";
   * export const openapi = apis.spec("v1", routes);
   * ```
   */
  spec<K extends keyof TMap & string>(
    api: K,
    routes: AnyRouteDef[],
  ): Record<string, unknown>;
}

/**
 * Factory — declare every API tag once and get back a typed `defineRoute`
 * + `toFunctions`. See the file-level example.
 *
 * Each per-API config is strictly checked against {@link ApiConfig}: unknown
 * keys (typos like `openApi` / `middleware`) are rejected at compile time,
 * including nested objects such as `openapi` — mirroring the CRUD server.
 *
 * @param configs  API-tag → per-API config (see {@link ApiConfig}).
 * @param options  Cross-API options (shared services container, etc).
 */
export function createApiRegistry<
  const TMap extends ApiConfigMap,
  TServices extends AnyServicesContainer = AnyServicesContainer,
>(
  configs: { [K in keyof TMap]: StrictApiConfig<TMap[K]> },
  options?: ApiRegistryOptions<TServices>,
): ApiRegistry<TMap, TServices> {
  const sharedServices = options?.services;
  const sharedErrorHandler = options?.errorHandler;
  const sharedLogger = options?.logger;

  return {
    configs: configs as unknown as TMap,

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defineRoute(def: any) {
      return def;
    },

    useCaseRoute(useCaseClass, meta) {
      return buildUseCaseRoute(useCaseClass, meta);
    },

    serverFor(api, routes) {
      const cfg = configs[api];
      if (!cfg) {
        throw new Error(
          `[ApiRegistry] unknown api "${api}". Registered: ${Object.keys(configs).join(", ")}`,
        );
      }
      return new HonoServer({
        ...cfg,
        api,
        routes,
        services: sharedServices,
        // Per-API errorHandler / logger (on the config) win over the shared ones.
        errorHandler: (cfg as ApiConfig).errorHandler ?? sharedErrorHandler,
        logger: (cfg as ApiConfig).logger ?? sharedLogger,
      });
    },

    spec(api, routes) {
      return this.serverFor(api, routes).buildOpenApiSpec();
    },

    toFunctions(routes, onRequest, opts) {
      const out = {} as { [K in keyof TMap & string]: ReturnType<OnRequestFn> };
      for (const api of Object.keys(configs) as Array<keyof TMap & string>) {
        const httpsOpts = {
          ...(opts?.defaults ?? {}),
          ...(opts?.per?.[api] ?? {}),
        };
        const server = new HonoServer({
          ...configs[api],
          api,
          routes,
          services: sharedServices,
          errorHandler:
            (configs[api] as ApiConfig).errorHandler ?? sharedErrorHandler,
          logger: (configs[api] as ApiConfig).logger ?? sharedLogger,
        });
        out[api] = Object.keys(httpsOpts).length
          ? server.toFunction(onRequest, httpsOpts)
          : server.toFunction(onRequest);
      }
      return out;
    },
  };
}
