/**
 * Public API for the file-based Hono server.
 *
 * @example
 * ```ts
 * // server.ts (one Cloud Function per `api` tag)
 * import { onRequest } from "firebase-functions/v2/https";
 * import { HonoServer } from "@lpdjs/firestore-repo-service/servers/hono";
 * import { routes } from "./domains/__generated__/routes.js";
 *
 * export const apiv1 = new HonoServer({
 *   api: "v1",
 *   basePath: "/v1",
 *   routes,
 *   openapi: {
 *     info: { title: "MyApp", version: "1.0.0" },
 *     securitySchemes: {
 *       bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
 *     },
 *     security: [{ bearerAuth: [] }],
 *   },
 * }).toFunction(onRequest, { region: "us-central1", invoker: "public" });
 * ```
 */

export { HonoServer } from "./server";
export {
  createApiRegistry,
  type ApiConfig,
  type ApiConfigMap,
  type ApiRegistry,
  type ApiRegistryOptions,
} from "./api-registry";
export { buildOpenApiDocument, renderDocsHtml } from "./openapi";
export { ValidationError } from "./types";
export {
  createServices,
  createRequestContextMiddleware,
  withRequestContext,
  type RequestContext,
  type ServicesOf,
  type ServiceProvider,
  type ServiceProviderMap,
  type ServicesContainer,
  type AnyServicesContainer,
} from "./services";

// Codegen exports — useful when wiring custom build pipelines without the CLI.
export {
  derivePath,
  toImportSpecifier,
  DEFAULT_DERIVE,
  type PathDeriveOptions,
} from "./codegen/path-utils";
export {
  scanRoutes,
  DEFAULT_SCANNER,
  type ScannerOptions,
  type ScannedRoute,
} from "./codegen/scanner";
export {
  generateRoutesManifest,
  generateFromRoot,
  DEFAULT_GENERATOR_BANNER,
  type GeneratorOptions,
  type GenerationResult,
} from "./codegen/generator";

export type {
  AnyRouteDef,
  HonoServerOptions,
  HttpMethod,
  OpenAPIConfig,
  OpenAPIInfo,
  PayloadSource,
  RouteDef,
  RouteHandler,
  RouteInterceptor,
  RouteModuleDefault,
} from "./types";
