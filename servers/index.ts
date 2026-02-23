/**
 * @module servers
 *
 * Optional server utilities for `@lpdjs/firestore-repo-service`.
 *
 * Two independently usable sub-modules:
 *
 * ## 1. Pagination function
 * Creates a Firebase HTTPS function that exposes a cursor-based pagination
 * endpoint for any repository with optional relation population.
 *
 * ```ts
 * import { createPaginationFunction } from "@lpdjs/firestore-repo-service/servers/pagination";
 * ```
 *
 * ## 2. Admin ORM server
 * Creates a full static admin UI served as a Firebase HTTPS function.
 * Forms are automatically generated from Zod schemas that map to the
 * repository model types.
 *
 * ```ts
 * import { createAdminServer } from "@lpdjs/firestore-repo-service/servers/admin";
 * ```
 *
 * ## Combined import
 * ```ts
 * import { createPaginationFunction, createAdminServer } from "@lpdjs/firestore-repo-service/servers";
 * ```
 *
 * ## Peer dependencies required for this module
 * ```json
 * {
 *   "firebase-functions": "^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0",
 *   "zod": "^3.0.0"
 * }
 * ```
 */

// ── Pagination ──────────────────────────────────────────────────────────────
export { createPaginationFunction } from "./pagination/index";
export type {
  ExtractRelationalKeys,
  ExtractRepoModel,
  PaginationFunctionOptions,
  PaginationHttpResult,
  SerializedCursor,
} from "./pagination/types";

// ── Admin ORM ───────────────────────────────────────────────────────────────
export { createAdminServer, MiniRouter } from "./admin/index";
export type {
  AdminRepoConfig,
  AdminRepoEntry,
  AdminServerOptions,
  BasicAuthConfig,
  Middleware,
  RepoRegistry,
  RouteHandler,
} from "./admin/index";

// ── Form generator (re-exported for custom use) ─────────────────────────────
export { renderField, renderForm, zodToFields } from "./admin/form-gen";
export type { FieldDescriptor } from "./admin/form-gen";

// ── Renderer (re-exported for custom pages) ─────────────────────────────────
export {
  ClientScript,
  CSS,
  renderDashboard,
  renderFormPage,
  renderList,
  renderPage,
} from "./admin/renderer";
export type { PageOptions } from "./admin/renderer";
