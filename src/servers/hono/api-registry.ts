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

import type {
  AnyRouteDef,
  HonoServerOptions,
  RouteDef,
} from "./types";
import { HonoServer } from "./server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OnRequestFn = (...args: any[]) => any;

/**
 * Per-API configuration. Same shape as {@link HonoServerOptions} minus the
 * `routes` (resolved by the registry) and `api` (the registry key).
 */
export type ApiConfig<TEnv extends Env = Env> = Omit<
  HonoServerOptions<TEnv>,
  "routes" | "api"
>;

/** Map of API tag → its config. */
export type ApiConfigMap = Record<string, ApiConfig>;

export interface ApiRegistry<TMap extends ApiConfigMap> {
  /** The registered configs (read-only). */
  readonly configs: TMap;

  /**
   * Typed `defineRoute` — the `api` field is constrained to `keyof TMap`.
   *
   * To expose the same logical endpoint under several APIs with different
   * `input` / `output` schemas, call `defineRoute` once per route and wrap
   * them in an array — per-call inference is preserved:
   *
   * ```ts
   * export default [
   *   defineRoute({ api: "v1", input: V1Input, handler: ({ input }) => ... }),
   *   defineRoute({ api: "v2", input: V2Input, handler: ({ input }) => ... }),
   * ];
   * ```
   */
  defineRoute<
    TIn extends z.ZodTypeAny | undefined = undefined,
    TOut extends z.ZodTypeAny | undefined = undefined,
  >(
    def: Omit<RouteDef<TIn, TOut>, "api"> & { api: keyof TMap & string },
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
      defaults?: Record<string, unknown>;
      per?: Partial<Record<keyof TMap & string, Record<string, unknown>>>;
    },
  ): { [K in keyof TMap & string]: ReturnType<OnRequestFn> };

  /** Build the underlying {@link HonoServer} for a given API (escape hatch). */
  serverFor<K extends keyof TMap & string>(
    api: K,
    routes: AnyRouteDef[],
  ): HonoServer;
}

/**
 * Factory — declare every API tag once and get back a typed `defineRoute`
 * + `toFunctions`. See the file-level example.
 */
export function createApiRegistry<const TMap extends ApiConfigMap>(
  configs: TMap,
): ApiRegistry<TMap> {
  return {
    configs,

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defineRoute(def: any) {
      return def;
    },

    serverFor(api, routes) {
      const cfg = configs[api];
      if (!cfg) {
        throw new Error(
          `[ApiRegistry] unknown api "${api}". Registered: ${Object.keys(configs).join(", ")}`,
        );
      }
      return new HonoServer({ ...cfg, api, routes });
    },

    toFunctions(routes, onRequest, opts) {
      const out = {} as { [K in keyof TMap & string]: ReturnType<OnRequestFn> };
      for (const api of Object.keys(configs) as Array<keyof TMap & string>) {
        const httpsOpts = {
          ...(opts?.defaults ?? {}),
          ...(opts?.per?.[api] ?? {}),
        };
        const server = new HonoServer({ ...configs[api], api, routes });
        out[api] = Object.keys(httpsOpts).length
          ? server.toFunction(onRequest, httpsOpts)
          : server.toFunction(onRequest);
      }
      return out;
    },
  };
}
