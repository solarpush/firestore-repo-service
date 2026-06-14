/**
 * @module servers
 *
 * Optional server utilities for `@lpdjs/firestore-repo-service`.
 *
 * Two independently usable sub-modules:
 *
 * ## 1. Admin ORM server
 * Creates a full static admin UI served as a Firebase HTTPS function.
 * Forms are automatically generated from Zod schemas that map to the
 * repository model types.
 *
 * ```ts
 * import { createAdminServer } from "@lpdjs/firestore-repo-service/servers/admin";
 * ```
 *
 * ## 2. CRUD API server
 * Creates a REST API server for CRUD operations with validation,
 * cursor-based pagination (bidirectional), and relation population.
 *
 * ```ts
 * import { createCrudServer } from "@lpdjs/firestore-repo-service/servers/crud";
 * ```
 *
 * ## Combined import
 * ```ts
 * import { createAdminServer, createCrudServer } from "@lpdjs/firestore-repo-service/servers";
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

// ── Unified factory (auto-binds repos to all server builders) ───────────────
export { createServers } from "./create-servers";
export type {
  BoundAdminRepoConfig,
  BoundAdminServerOptions,
  BoundCrudRepoConfig,
  BoundCrudServerOptions,
  BoundFirestoreSyncConfig,
  CreateServersDeps,
} from "./create-servers";

// ── Admin ORM (types only — use `createServers().admin()` to build) ─────────
export { MiniRouter } from "./admin/index";
export type {
  AdminRepoConfig,
  AdminRepoEntry,
  AdminServerOptions,
  BasicAuthConfig,
  Middleware,
  RepoRegistry,
  RouteHandler,
} from "./admin/index";

// ── CRUD API (types only — use `createServers().crud()` to build) ───────────
export type {
  ApiResponse,
  CrudRepoConfig,
  CrudRepoEntry,
  CrudRepoRegistry,
  CrudServerOptions,
  FieldRole,
  ListResponseData,
  QueryRequestBody,
  RepoFieldPath,
  RepoRelationKeys,
  UserFieldPath,
} from "./crud/index";

// ── Form generator (re-exported for custom use) ─────────────────────────────
export { renderField, renderForm, zodToFields } from "./admin/form-gen";
export type { FieldDescriptor } from "./admin/form-gen";

// ── Renderer (re-exported for custom pages) ─────────────────────────────────
export {
  CSS,
  ClientScript,
  renderDashboard,
  renderFormPage,
  renderList,
  renderPage,
} from "./admin/renderer";
export type { PageOptions } from "./admin/renderer";

// ── Security headers middleware (re-exported for manual use) ────────────────
export {
  DEFAULT_HTML_CSP,
  securityHeaders,
} from "./utils/security-headers";
export type { SecurityHeadersOptions } from "./utils/security-headers";
