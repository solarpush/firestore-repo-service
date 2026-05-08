/**
 * @module servers/create-servers
 *
 * Unified factory that pre-binds a repository mapping to all server builders
 * (admin UI, CRUD REST API, Firestore→SQL sync admin).
 *
 * The goal is purely DX: instead of repeating `repo: repos.posts` for each
 * entry — and losing strong inference on `keyof Model` paths because the key
 * `"posts"` is decoupled from the value `repos.posts` — the bound builders
 * derive the repo (and thus the model type) from the registry key:
 *
 * ```ts
 * const servers = createServers(repos, { onRequest });
 *
 * export const admin = servers.admin({
 *   basePath: "/admin",
 *   repos: {
 *     posts: { path: "posts", fieldsConfig: { title: ["create"] } },
 *     //                                       ^ typed against repos.posts model
 *   },
 * });
 *
 * export const api = servers.crud({
 *   basePath: "/api",
 *   repos: {
 *     posts: { path: "posts", allowDelete: true },
 *   },
 * });
 *
 * export const { functions } = servers.sync({
 *   deps: { firestoreTriggers, pubsubHandler, pubsub },
 *   adapter,
 *   admin: { auth: { type: "basic", username: "admin", password: "secret" } },
 * });
 * ```
 *
 * When `onRequest` is provided to `createServers`, the admin and CRUD
 * builders return a ready-to-export Cloud Function (wrapped with the
 * caller-provided `onRequest`). Otherwise they return the raw handler.
 */

import type { HttpsOptions, onRequest as OnRequestFn } from "firebase-functions/v2/https";
import { createHistoryTriggers } from "../history/triggers";
import type { HistoryTriggersConfig } from "../history/types";
import type { ConfiguredRepository } from "../repositories/types";
import type { FirestoreSyncConfig } from "../sync/types";
import { createFirestoreSync } from "../sync/create-sync";
import {
  type AdminRepoConfig,
  type AdminServerOptions,
  createAdminServer,
} from "./admin/index";
import { createCrudServer } from "./crud/index";
import type { CrudRepoConfig, CrudServerOptions } from "./crud/types";

// ---------------------------------------------------------------------------
// Bound option types
// ---------------------------------------------------------------------------

/** Per-repo admin config with `repo` omitted (auto-bound from the registry key). */
export type BoundAdminRepoConfig<TRepo extends ConfiguredRepository<any>> = Omit<
  AdminRepoConfig<TRepo>,
  "repo"
>;

/** Per-repo CRUD config with `repo` omitted (auto-bound from the registry key). */
export type BoundCrudRepoConfig<TRepo extends ConfiguredRepository<any>> = Omit<
  CrudRepoConfig<TRepo>,
  "repo"
>;

/**
 * Admin server options for the bound builder.
 * `repos` becomes a partial record so callers can expose a subset of the
 * underlying registry, and each entry omits `repo` (injected from the key).
 */
export interface BoundAdminServerOptions<
  TRepos extends Record<string, ConfiguredRepository<any>>,
> extends Omit<AdminServerOptions<TRepos>, "repos"> {
  repos: { [K in keyof TRepos]?: BoundAdminRepoConfig<TRepos[K]> };
}

/** CRUD server options for the bound builder. */
export interface BoundCrudServerOptions<
  TRepos extends Record<string, ConfiguredRepository<any>>,
> extends Omit<CrudServerOptions<TRepos>, "repos"> {
  repos: { [K in keyof TRepos]?: BoundCrudRepoConfig<TRepos[K]> };
}

/**
 * Sync config for the bound builder — identical to `FirestoreSyncConfig`
 * but the top-level `repoMapping` argument is supplied by `createServers`.
 */
export type BoundFirestoreSyncConfig<TRepos extends Record<string, any>> =
  FirestoreSyncConfig<TRepos>;

// ---------------------------------------------------------------------------
// Shared deps
// ---------------------------------------------------------------------------

/** Optional dependencies shared across every server. */
export interface CreateServersDeps {
  /**
   * `onRequest` from `firebase-functions/v2/https`. When provided, the
   * admin/CRUD builders return a ready-to-export Cloud Function instead of
   * the raw handler. Also forwarded to the sync admin (so the bundled
   * `adminsync` Cloud Function is generated automatically).
   */
  onRequest?: typeof OnRequestFn;
  /**
   * Default `httpsOptions` applied to every server. Per-server options
   * override these defaults.
   */
  httpsOptions?: HttpsOptions;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type RawHandler = ((req: any, res: any) => any) & {
  httpsOptions?: HttpsOptions;
};

function maybeWrap<H extends RawHandler>(
  handler: H,
  deps: CreateServersDeps,
): H | ReturnType<typeof OnRequestFn> {
  if (!deps.onRequest) return handler;
  const opts = handler.httpsOptions ?? deps.httpsOptions;
  return opts ? deps.onRequest(opts, handler) : deps.onRequest(handler);
}

function injectRepos<
  TRepos extends Record<string, ConfiguredRepository<any>>,
  TBoundCfg,
>(
  repos: TRepos,
  bound: { [K in keyof TRepos]?: TBoundCfg },
  serverName: string,
): Record<string, TBoundCfg & { repo: ConfiguredRepository<any> }> {
  const out: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(bound)) {
    if (!cfg) continue;
    const repo = repos[name as keyof TRepos];
    if (!repo) {
      throw new Error(
        `[createServers.${serverName}] Unknown repo "${name}" — not present in the registry passed to createServers().`,
      );
    }
    out[name] = { ...(cfg as object), repo } as any;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pre-binds a repository mapping to all server builders.
 *
 * @template TRepos - Repository registry; inferred at the call site.
 * @param repos - The repository mapping (e.g. result of `createRepositoryMapping`).
 * @param deps  - Optional shared deps (notably `onRequest` for auto-wrapping).
 *
 * @example
 * ```ts
 * import { onRequest } from "firebase-functions/v2/https";
 * import { createServers } from "@lpdjs/firestore-repo-service/servers";
 *
 * const servers = createServers(repos, { onRequest });
 *
 * export const admin = servers.admin({
 *   basePath: "/admin",
 *   repos: {
 *     posts: { path: "posts", allowDelete: true },
 *     users: { path: "users" },
 *   },
 * });
 * ```
 */
export function createServers<
  TRepos extends Record<string, ConfiguredRepository<any>>,
>(repos: TRepos, deps: CreateServersDeps = {}) {
  return {
    /**
     * Build the admin UI handler with `repo` auto-injected from each registry key.
     * Returns a Cloud Function when `onRequest` was passed to `createServers`,
     * otherwise the raw HTTP handler.
     */
    admin(options: BoundAdminServerOptions<TRepos>) {
      const fullRepos = injectRepos<TRepos, BoundAdminRepoConfig<any>>(
        repos,
        options.repos,
        "admin",
      );
      const handler = createAdminServer({
        ...options,
        repos: fullRepos as AdminServerOptions<TRepos>["repos"],
        httpsOptions: options.httpsOptions ?? deps.httpsOptions,
      });
      return maybeWrap(handler, deps);
    },

    /**
     * Build the CRUD REST API handler with `repo` auto-injected from each
     * registry key. Returns a Cloud Function when `onRequest` was passed to
     * `createServers`, otherwise the raw HTTP handler (which still exposes
     * `.spec()` and `.httpsOptions` on the raw form).
     */
    crud(options: BoundCrudServerOptions<TRepos>) {
      const fullRepos = injectRepos<TRepos, BoundCrudRepoConfig<any>>(
        repos,
        options.repos,
        "crud",
      );
      const handler = createCrudServer({
        ...options,
        repos: fullRepos as CrudServerOptions<TRepos>["repos"],
        httpsOptions: options.httpsOptions ?? deps.httpsOptions,
      });
      return maybeWrap(handler, deps);
    },

    /**
     * Build the Firestore→SQL sync pipeline using the bound registry.
     * Forwards the shared `onRequest` to the sync admin config so the
     * bundled `adminsync` Cloud Function is auto-generated.
     */
    sync(config: BoundFirestoreSyncConfig<TRepos>) {
      const merged: BoundFirestoreSyncConfig<TRepos> = { ...config };
      if (deps.onRequest && merged.admin && !merged.admin.onRequest) {
        merged.admin = {
          ...merged.admin,
          onRequest: deps.onRequest as any,
          httpsOptions: merged.admin.httpsOptions ?? deps.httpsOptions,
        };
      }
      return createFirestoreSync(repos, merged);
    },

    /**
     * Build Firestore history (change-log) triggers for every repo whose
     * config has `history.enabled === true`. Returns the trigger map
     * (keys: `${repoName}_onHistory`).
     *
     * Note: history triggers are Firestore document triggers, not HTTPS
     * functions, so they do **not** inherit the `httpsOptions` declared on
     * `createServers`. Region / runtime options must be configured via the
     * Firebase Functions `setGlobalOptions(...)` API or by post-wrapping
     * the returned trigger.
     *
     * @example
     * ```ts
     * import * as firestoreTriggers from "firebase-functions/v2/firestore";
     *
     * export const historyTriggers = servers.history({
     *   deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
     *   defaults: { ttl: { days: 365 } },
     * });
     * // export const { posts_onHistory } = historyTriggers;
     * ```
     */
    history(config: HistoryTriggersConfig<TRepos>): Record<string, any> {
      return createHistoryTriggers(repos, config);
    },
  };
}
