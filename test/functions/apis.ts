import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { enrichUser } from "./auth.middleware";

export const apis = createApiRegistry({
  v1: {
    basePath: "/v1",

    /** Configuration OpenAPI 3.1 — doc accessible sur /v1/__docs */
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
    interceptor: async ({ c, next, route }) => {
      const data = await next();

      return c.json({ data, intercepted: true });
    },
    onError: (err, c) => {
      console.error("Unhandled error in HonoServer:", err);
      return c.json({ error: "Internal Server Error" });
    },

    /** Valider aussi la réponse du handler contre le schéma `output` Zod. */
    validateOutput: false,
    middlewares: [enrichUser],
    /** Log chaque route montée au démarrage (utile en dev, désactiver en prod). */
    verbose: process.env["NODE_ENV"] !== "production",
  } as const,
  v2: {
    basePath: "/v2",

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
    interceptor: async ({ c, next, route }) => {
      const data = await next();

      return c.json({ data, intercepted: true });
    },
    onError: (err, c) => {
      console.error("Unhandled error in HonoServer:", err);
      return c.json({ error: "Internal Server Error" });
    },

    /** Valider aussi la réponse du handler contre le schéma `output` Zod. */
    validateOutput: false,
    middlewares: [enrichUser],
    /** Log chaque route montée au démarrage (utile en dev, désactiver en prod). */
    verbose: process.env["NODE_ENV"] !== "production",
  } as const,
});
export const defineRoute = apis.defineRoute;
