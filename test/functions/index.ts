import {
  buildRepositoryRelations,
  createRepositoryConfig,
  createRepositoryMapping,
  createServers,
  setDateHandling,
} from "@lpdjs/firestore-repo-service";
import { initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/https";
import z from "zod";

// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (firestore-repo-services)
initializeApp({
  projectId: "firestore-repo-services",
});

const db = getFirestore();
setDateHandling("normalize");
// ============================================
// Models (interfaces pour repos sans schema Zod)
// ============================================

// ============================================
// Zod Schemas
// ============================================

export const postSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  userId: z.string().nullish(),
  address: z.object({ street: z.string(), city: z.string() }),
  title: z.string().nullish(),
  content: z.string().nullish(),
  status: z.enum(["draft", "published", "archived"]),
  comment: z.string().nullish(),
  views: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const userSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  age: z.number(),
  isActive: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const CommentModel = z.object({
  docId: z.string(),
  documentPath: z.string(),
  postId: z.string(),
  userId: z.string(),
  content: z.string(),
  likes: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ComputeSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  value1: z.number(),
  value2: z.number(),
  result: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
// ============================================
// Repository Configuration
// ============================================

// Step 1: Build the base mapping
const repositoryMapping = {
  users: createRepositoryConfig(userSchema)({
    path: "users",
    isGroup: false,
    foreignKeys: ["docId", "email"] as const,
    queryKeys: ["name", "isActive"] as const,
    documentKey: "docId",
    pathKey: "documentPath",
    createdKey: "createdAt",
    updatedKey: "updatedAt",
    refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
    history: { enabled: false },
  }),

  posts: createRepositoryConfig(postSchema)({
    path: "posts",
    isGroup: false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys: ["status", "userId"] as const,
    documentKey: "docId",
    pathKey: "documentPath",
    createdKey: "createdAt",
    updatedKey: "updatedAt",
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
    history: {
      enabled: true,
      ttl: {
        days: 30,
      },
      exclude: ["comment"] as const,
      meta: { userId: "userId", comment: "comment" },
      subcollection: "post_history",
    },
  }),

  comments: createRepositoryConfig(CommentModel)({
    path: "comments",
    isGroup: true,
    foreignKeys: ["docId", "postId", "userId"] as const,
    queryKeys: ["postId", "userId"] as const,
    documentKey: "docId",
    pathKey: "documentPath",
    createdKey: "createdAt",
    updatedKey: "updatedAt",
    refCb: (db: Firestore, postId: string, docId: string) =>
      db.collection("posts").doc(postId).collection("comments").doc(docId),
    history: { enabled: false },
  }),
  compute: createRepositoryConfig(ComputeSchema)({
    path: "compute",
    isGroup: false,
    foreignKeys: ["docId"] as const,
    queryKeys: ["value1", "value2"] as const,
    documentKey: "docId",
    pathKey: "documentPath",
    createdKey: "createdAt",
    updatedKey: "updatedAt",
    refCb: (db: Firestore, docId: string) =>
      db.collection("compute").doc(docId),
    history: { enabled: false },
  }),
};
// Step 2: Build relations with full type validation
const repositoryMappingWithRelations = buildRepositoryRelations(
  repositoryMapping,
  {
    // Un user a plusieurs posts (via docId → userId)
    users: {
      docId: { repo: "posts", key: "userId", type: "many" as const },
    },
    // Un post appartient à un user et a plusieurs comments
    posts: {
      userId: { repo: "users", key: "docId", type: "one" as const },
      docId: { repo: "comments", key: "postId", type: "many" as const },
    },
    // Un comment appartient à un post et à un user
    comments: {
      postId: { repo: "posts", key: "docId", type: "one" as const },
      userId: { repo: "users", key: "docId", type: "one" as const },
    },
  },
);

// Step 3: Create the repository mapping
export const repos = createRepositoryMapping(
  db,
  repositoryMappingWithRelations,
);

export const server = onRequest(async (req, res) => {
  try {
    res.json({
      message: "Success!",
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: String(error) });
  }
});
// ============================================
// Servers — unified factory (admin UI, CRUD API, sync) all bound to `repos`
// ============================================
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import { firebaseAuth } from "@lpdjs/firestore-repo-service/servers/auth";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { getAuth } from "firebase-admin/auth";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";
import { apis } from "./apis.js";
import { routes } from "./domains/__generated__/routes";

const servers = createServers(repos, {
  onRequest,
  httpsOptions: { ingressSettings: "ALLOW_ALL", invoker: "public" },
});

export const admin = servers.admin({
  auth: firebaseAuth({
    getAuth: () => getAuth(),
    // Cookie mode → renders the inline login page on unauthenticated GETs.
    // Use "bearer" only for REST APIs (no UI), or "both" for hybrid backends.
    mode: "cookie",
    // Required when loginPage is enabled (default in cookie/both modes).
    // Find both in Firebase Console → Project Settings → General → Web app.
    apiKey: process.env["WEB_API_KEY"],
    authDomain: process.env["AUTH_DOMAIN"],
    allow: () => true,
  }),
  basePath: "/",
  repos: {
    posts: {
      path: "posts",
      fieldsConfig: {
        docId: ["filterable"],
        title: ["create", "mutable", "filterable"],
        content: ["create", "mutable"],
        status: ["mutable", "filterable"],
        address: ["create", "mutable", "filterable"],
        views: ["create", "mutable", "filterable"],
        userId: ["filterable"],
      },
      relationalFields: [
        { key: "userId", column: "Associated author" },
        { key: "docId", column: "Associated comments" },
      ],
      allowDelete: true,
    },
    users: {
      path: "users",
      allowDelete: false,
      fieldsConfig: {
        name: ["create", "mutable", "filterable"],
        email: ["create", "mutable", "filterable"],
        age: ["create", "mutable", "filterable"],
        isActive: ["create", "mutable", "filterable"],
        docId: ["filterable"],
      },
      relationalFields: [{ key: "docId", column: "Associated posts" }],
    },
    comments: {
      path: "comments",
      allowDelete: true,
      fieldsConfig: {
        docId: ["filterable"],
        postId: ["filterable"],
        likes: ["filterable"],
        content: ["create", "mutable"],
      },
      relationalFields: [{ key: "postId", column: "Associated posts" }],
    },
    compute: {
      path: "compute",
      allowDelete: true,
      fieldsConfig: {
        docId: ["filterable"],
        value1: ["create", "mutable", "filterable"],
        value2: ["create", "mutable", "filterable"],
        result: ["mutable", "filterable"],
      },
    },
  },
});

export const crud = servers.crud({
  basePath: "/",

  auth: firebaseAuth({
    getAuth: () => getAuth(),
    // Cookie mode → renders the inline login page on unauthenticated GETs.
    // Use "bearer" only for REST APIs (no UI), or "both" for hybrid backends.
    mode: "both",
    // Required when loginPage is enabled (default in cookie/both modes).
    // Find both in Firebase Console → Project Settings → General → Web app.
    apiKey: process.env["WEB_API_KEY"],
    authDomain: process.env["AUTH_DOMAIN"],
    allow: () => true,
  }),

  repos: {
    posts: {
      path: "posts",
      rules: {
        create: () => true,
        update: () => true,
        delete: () => true,
        list: () => true,
        get: () => true,
        filter: () => true,
      },
      fieldsConfig: {
        title: ["create", "mutable", "filterable"],
        content: ["create", "mutable"],
        status: ["create", "filterable"],
        address: ["create"],
        views: ["create"],
        userId: ["filterable"],
        comment: ["create", "mutable", "filterable"],
      },
      allowDelete: true,
    },
    users: {
      path: "users",
      allowDelete: true,
      rules: {
        create: () => true,
        update: () => true,
        delete: () => true,
        list: () => true,
        get: () => true,
        filter: () => true,
      },
      fieldsConfig: {
        name: ["create", "mutable", "filterable"],
        email: ["create", "mutable", "filterable"],
        age: ["create", "mutable", "filterable"],
        isActive: ["create", "mutable", "filterable"],
        docId: ["filterable"],
      },
    },
    comments: {
      path: "comments",
      allowDelete: true,
      rules: {
        create: () => true,
        update: () => true,
        delete: () => true,
        list: () => true,
        get: () => true,
        filter: () => true,
      },
      fieldsConfig: {
        postId: ["create", "filterable"],
        userId: ["create"],
        content: ["create", "mutable"],
        likes: ["mutable", "filterable"],
        docId: ["filterable"],
      },
    },
  },
  openapi: {
    title: "Mon API",
    version: "1.0.0",
    servers: [
      { url: "http://127.0.0.1:5001/firestore-repo-services/us-central1/crud" },
    ],
    auth: "bearer",
  },
});

// Firestore → BigQuery sync
export const sync = servers.sync({
  deps: {
    firestoreTriggers,
    pubsubHandler,
    pubsub: new PubSub(),
  },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "firestore-repo-services" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  batchSize: 500,
  flushIntervalMs: 10_000,
  workerOptions: {
     concurrency: 40,
   maxInstances: 1,
   retry: true,
   cpu: 1,
   memory: "512MiB",
   timeoutSeconds: 300,
  },
  admin: {
    auth: firebaseAuth({
      getAuth: () => getAuth(),
      mode: "cookie",
      apiKey: process.env["WEB_API_KEY"],
      authDomain: process.env["AUTH_DOMAIN"],
      allow: () => true,
    }),
    basePath: "/",
    featuresFlag: {
      manualSync: true,
      healthCheck: true,
      configCheck: true,
    },
  },
  repos: {
    users: {
      exclude: ["documentPath"],
      columnMap: { docId: "user_id" },
      tableName: "users",
    },
    posts: { columnMap: { docId: "post_id" } },
    comments: {
      triggerPath: "posts/{postId}/comments/{docId}",
    },
  },
});

// History triggers (Firestore document triggers — not HTTPS)
export const history = servers.history({
  deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
  defaults: { ttl: { days: 365 } },
});

/// honoServer et routes d'exemple — voir test/hono/index.ts et test/hono/domains/posts/useCases/createPost/routes.ts pour une implémentation complète.

const auth = firebaseAuth({
  getAuth: () => getAuth(),
  // API REST → bearer token only, pas de login page UI.
  mode: "bearer",
  allow: (user) => user !== null, // tout utilisateur Firebase authentifié
});

// ---------------------------------------------------------------------------
// Cloud Function : apiv1
//
// Montée sur https://<region>-<project>.cloudfunctions.net/apiv1
// OpenAPI spec : /v1/__openapi.json
// Scalar UI    : /v1/__docs
// ---------------------------------------------------------------------------
export type AppEnv = {
  Variables: {
    user: { uid: string; role: "admin" | "user"; email: string };
  };
};

// defineRoute typé pour toute l'app

export const api = apis.toFunctions(routes, onRequest, {
  defaults: {
    region: "us-central1",
    invoker: "public",
  },
  // Passer `memory`, `timeoutSeconds`, etc. si besoin.
});

// export const api = new HonoServer({
//   /**
//    * Filtre les routes dont `api === "v1"`.
//    * Permet de partager un seul manifest entre plusieurs fonctions
//    * (ex : "v1", "webhooks", "admin") sans duplication.
//    */
//   api: "v1",

//   /** Préfixe de toutes les routes — ex : /v1/posts. */
//   basePath: "/v1",

//   /** Manifest généré par le codegen. */
//   routes,

//   /** Configuration OpenAPI 3.1 — doc accessible sur /v1/__docs */
//   openapi: {
//     info: {
//       title: "Mon API",
//       version: "1.0.0",
//       description: "Exemple Hono file-based API sur Firebase Functions v2",
//     },
//     servers: [
//       { url: "https://us-central1-my-project.cloudfunctions.net/apiv1" },
//       { url: "http://127.0.0.1:5001/my-project/us-central1/apiv1" },
//     ],
//     securitySchemes: {
//       bearerAuth: {
//         type: "http",
//         scheme: "bearer",
//         bearerFormat: "Firebase JWT",
//       },
//     },
//     security: [{ bearerAuth: [] }],
//   },
//   interceptor: async ({ c, next, route }) => {
//     const data = await next();

//     return c.json({ data, intercepted: true });
//   },
//   onError: (err, c) => {
//     console.error("Unhandled error in HonoServer:", err);
//     return c.json({ error: "Internal Server Error" });
//   },

//   /** Valider aussi la réponse du handler contre le schéma `output` Zod. */
//   validateOutput: false,
//   middlewares: [enrichUser],
//   /** Log chaque route montée au démarrage (utile en dev, désactiver en prod). */
//   verbose: process.env["NODE_ENV"] !== "production",
// }).toFunction(onRequest, {
//   region: "us-central1",
//   invoker: "public",
//   // Passer `memory`, `timeoutSeconds`, etc. si besoin.
// });
