import {
  BaseErrorHandler,
  createApiRegistry,
  firebaseDocsAuth,
} from "@lpdjs/firestore-repo-service/servers/hono";
import { getAuth } from "firebase-admin/auth";
import z from "zod";
import { AppErrorHandler, appLogger } from "./app-error";
import { enrichUser } from "./auth.middleware";
import { services } from "./services";

export const apis = createApiRegistry(
  {
    v1: {
      basePath: "/",
      openapi: {
        info: {
          title: "Mon API",
          version: "1.0.0",
          description: "Exemple Hono file-based API sur Firebase Functions v2",
        },
        // Gate the docs behind a Firebase login form + session cookie (same
        // flow as the admin server). `mode: "both"` also accepts a Bearer
        // token, handy when embedding the docs in an authenticated iframe.
        docsAuth: firebaseDocsAuth({
          getAuth,
          apiKey: process.env["FIREBASE_API_KEY"] ?? "demo-api-key",
          authDomain:
            process.env["FIREBASE_AUTH_DOMAIN"] ?? "my-project.firebaseapp.com",
          mode: "both",
        }),
        servers: [
          { url: "https://us-central1-my-project.cloudfunctions.net/apiv1" },
          { url: "http://127.0.0.1:5001/my-project/us-central1/apiv1" },
        ],
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Firebase JWT",
          },
        },
        security: [{ bearerAuth: [] }],
      },
      interceptor: {
        output: (routeOutput) =>
          z.object({
            data: routeOutput ?? z.unknown(),
            intercepted: z.boolean(),
          }),
        handler: async ({ c, next, route }) => {
          const data = await next();

          return c.json({ data, intercepted: null });
        },
      },
      onError: (err, c) => {
        console.error("Unhandled error in HonoServer:", err);
        return c.json({ error: "Internal Server Error" });
      },

      // User-facing API: localized AppError mapping + AppLogger.
      // gcpLogs link enabled outside production so devs can jump to the log.
      errorHandler: new AppErrorHandler({
        gcpLogs: { enabled: process.env["NODE_ENV"] !== "production" },
      }),
      logger: appLogger,

      /** Valider aussi la réponse du handler contre le schéma `output` Zod. */
      validateOutput: false,
      middlewares: [enrichUser],
      /** Log chaque route montée au démarrage (utile en dev, désactiver en prod). */
      verbose: process.env["NODE_ENV"] !== "production",
    } as const,
    v2: {
      basePath: "/",

      /** Configuration OpenAPI 3.1 — doc accessible sur /v2/__docs */
      openapi: {
        info: {
          title: "Mon API",
          version: "1.0.0",
          description: "Exemple Hono file-based API sur Firebase Functions v2",
        },
        servers: [
          { url: "https://us-central1-my-project.cloudfunctions.net/apiv1" },
          { url: "http://127.0.0.1:5001/my-project/us-central1/apiv1" },
        ],
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Firebase JWT",
          },
        },
        security: [{ bearerAuth: [] }],
      },
      interceptor: {
        output: (routeOutput) =>
          z.object({
            data: routeOutput ?? z.unknown(),
            intercepted: z.boolean(),
          }),
        handler: async ({ c, next, route }) => {
          const data = await next();

          return c.json({ data, intercepted: true });
        },
      },
      onError: (err, c) => {
        console.error("Unhandled error in HonoServer:", err);
        return c.json({ error: "Internal Server Error" });
      },

      // API without user-facing constraints: built-in mapping only.
      errorHandler: new BaseErrorHandler(),
      logger: appLogger,

      /** Valider aussi la réponse du handler contre le schéma `output` Zod. */
      validateOutput: false,
      middlewares: [enrichUser],
      /** Log chaque route montée au démarrage (utile en dev, désactiver en prod). */
      verbose: process.env["NODE_ENV"] !== "production",
    } as const,
  },
  { services },
);
export const defineRoute = apis.defineRoute;
export const useCaseRoute = apis.useCaseRoute;
