"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = exports.history = exports.sync = exports.crud = exports.admin = exports.server = exports.repos = exports.ComputeSchema = exports.CommentModel = exports.userSchema = exports.postSchema = void 0;
const firestore_repo_service_1 = require("@lpdjs/firestore-repo-service");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/https");
const zod_1 = __importDefault(require("zod"));
// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (firestore-repo-services)
(0, app_1.initializeApp)({
    projectId: "firestore-repo-services",
});
const db = (0, firestore_1.getFirestore)();
(0, firestore_repo_service_1.setDateHandling)("normalize");
// ============================================
// Models (interfaces pour repos sans schema Zod)
// ============================================
// ============================================
// Zod Schemas
// ============================================
exports.postSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    userId: zod_1.default.string().nullish(),
    address: zod_1.default.object({ street: zod_1.default.string(), city: zod_1.default.string() }),
    title: zod_1.default.string().nullish(),
    content: zod_1.default.string().nullish(),
    status: zod_1.default.enum(["draft", "published", "archived"]),
    comment: zod_1.default.string().nullish(),
    views: zod_1.default.number(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
exports.userSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    email: zod_1.default.string(),
    name: zod_1.default.string().nullable(),
    age: zod_1.default.number(),
    isActive: zod_1.default.boolean().nullable(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
exports.CommentModel = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    postId: zod_1.default.string(),
    userId: zod_1.default.string(),
    content: zod_1.default.string(),
    likes: zod_1.default.number(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
exports.ComputeSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    value1: zod_1.default.number(),
    value2: zod_1.default.number(),
    result: zod_1.default.number(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
// ============================================
// Repository Configuration
// ============================================
// Step 1: Build the base mapping
const repositoryMapping = {
    users: (0, firestore_repo_service_1.createRepositoryConfig)(exports.userSchema)({
        path: "users",
        isGroup: false,
        foreignKeys: ["docId", "email"],
        queryKeys: ["name", "isActive"],
        documentKey: "docId",
        pathKey: "documentPath",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        refCb: (db, docId) => db.collection("users").doc(docId),
        history: { enabled: false },
    }),
    posts: (0, firestore_repo_service_1.createRepositoryConfig)(exports.postSchema)({
        path: "posts",
        isGroup: false,
        foreignKeys: ["docId", "userId"],
        queryKeys: ["status", "userId"],
        documentKey: "docId",
        pathKey: "documentPath",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        refCb: (db, docId) => db.collection("posts").doc(docId),
        history: {
            enabled: true,
            ttl: {
                days: 30,
            },
            exclude: ["comment"],
            meta: { userId: "userId", comment: "comment" },
            subcollection: "post_history",
        },
    }),
    comments: (0, firestore_repo_service_1.createRepositoryConfig)(exports.CommentModel)({
        path: "comments",
        isGroup: true,
        foreignKeys: ["docId", "postId", "userId"],
        queryKeys: ["postId", "userId"],
        documentKey: "docId",
        pathKey: "documentPath",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        refCb: (db, postId, docId) => db.collection("posts").doc(postId).collection("comments").doc(docId),
        history: { enabled: false },
    }),
    compute: (0, firestore_repo_service_1.createRepositoryConfig)(exports.ComputeSchema)({
        path: "compute",
        isGroup: false,
        foreignKeys: ["docId"],
        queryKeys: ["value1", "value2"],
        documentKey: "docId",
        pathKey: "documentPath",
        createdKey: "createdAt",
        updatedKey: "updatedAt",
        refCb: (db, docId) => db.collection("compute").doc(docId),
        history: { enabled: false },
    }),
};
// Step 2: Build relations with full type validation
const repositoryMappingWithRelations = (0, firestore_repo_service_1.buildRepositoryRelations)(repositoryMapping, {
    // Un user a plusieurs posts (via docId → userId)
    users: {
        docId: { repo: "posts", key: "userId", type: "many" },
    },
    // Un post appartient à un user et a plusieurs comments
    posts: {
        userId: { repo: "users", key: "docId", type: "one" },
        docId: { repo: "comments", key: "postId", type: "many" },
    },
    // Un comment appartient à un post et à un user
    comments: {
        postId: { repo: "posts", key: "docId", type: "one" },
        userId: { repo: "users", key: "docId", type: "one" },
    },
});
// Step 3: Create the repository mapping
exports.repos = (0, firestore_repo_service_1.createRepositoryMapping)(db, repositoryMappingWithRelations);
exports.server = (0, https_1.onRequest)(async (req, res) => {
    try {
        res.json({
            message: "Success!",
        });
    }
    catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: String(error) });
    }
});
// ============================================
// Servers — unified factory (admin UI, CRUD API, sync) all bound to `repos`
// ============================================
const bigquery_1 = require("@google-cloud/bigquery");
const pubsub_1 = require("@google-cloud/pubsub");
const auth_1 = require("@lpdjs/firestore-repo-service/servers/auth");
const bigquery_2 = require("@lpdjs/firestore-repo-service/sync/bigquery");
const auth_2 = require("firebase-admin/auth");
const firestoreTriggers = __importStar(require("firebase-functions/v2/firestore"));
const pubsubHandler = __importStar(require("firebase-functions/v2/pubsub"));
const apis_js_1 = require("./apis.js");
const routes_1 = require("./domains/__generated__/routes");
const servers = (0, firestore_repo_service_1.createServers)(exports.repos, {
    onRequest: https_1.onRequest,
    httpsOptions: { ingressSettings: "ALLOW_ALL", invoker: "public" },
});
exports.admin = servers.admin({
    auth: (0, auth_1.firebaseAuth)({
        getAuth: () => (0, auth_2.getAuth)(),
        // Cookie mode → renders the inline login page on unauthenticated GETs.
        // Use "bearer" only for REST APIs (no UI), or "both" for hybrid backends.
        mode: "cookie",
        // Required when loginPage is enabled (default in cookie/both modes).
        // Find both in Firebase Console → Project Settings → General → Web app.
        apiKey: process.env["FIREBASE_WEB_API_KEY"] ??
            "AIzaSyBTs5eDLAdi-cO0p3BVzm1G0MTl_LnvVbA",
        authDomain: process.env["FIREBASE_AUTH_DOMAIN"] ??
            "firestore-repo-services.firebaseapp.com",
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
exports.crud = servers.crud({
    basePath: "/",
    auth: (0, auth_1.firebaseAuth)({
        getAuth: () => (0, auth_2.getAuth)(),
        // Cookie mode → renders the inline login page on unauthenticated GETs.
        // Use "bearer" only for REST APIs (no UI), or "both" for hybrid backends.
        mode: "both",
        // Required when loginPage is enabled (default in cookie/both modes).
        // Find both in Firebase Console → Project Settings → General → Web app.
        apiKey: process.env["FIREBASE_WEB_API_KEY"] ??
            "AIzaSyBTs5eDLAdi-cO0p3BVzm1G0MTl_LnvVbA",
        authDomain: process.env["FIREBASE_AUTH_DOMAIN"] ??
            "firestore-repo-services.firebaseapp.com",
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
exports.sync = servers.sync({
    deps: {
        firestoreTriggers,
        pubsubHandler,
        pubsub: new pubsub_1.PubSub(),
    },
    adapter: new bigquery_2.BigQueryAdapter({
        bigquery: new bigquery_1.BigQuery({ projectId: "firestore-repo-services" }),
        datasetId: "firestore_sync",
    }),
    topicPrefix: "firestore-sync",
    autoMigrate: true,
    batchSize: 500,
    flushIntervalMs: 10000,
    workerOptions: {
        concurrency: 5,
        maxInstances: 10,
    },
    admin: {
        auth: (0, auth_1.firebaseAuth)({
            getAuth: () => (0, auth_2.getAuth)(),
            mode: "cookie",
            apiKey: process.env["FIREBASE_WEB_API_KEY"] ?? "REPLACE_ME",
            authDomain: process.env["FIREBASE_AUTH_DOMAIN"] ??
                "firestore-repo-services.firebaseapp.com",
            allow: () => true,
        }),
        basePath: "/",
        featuresFlag: {
            viewQueue: true,
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
exports.history = servers.history({
    deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
    defaults: { ttl: { days: 365 } },
});
/// honoServer et routes d'exemple — voir test/hono/index.ts et test/hono/domains/posts/useCases/createPost/routes.ts pour une implémentation complète.
const auth = (0, auth_1.firebaseAuth)({
    getAuth: () => (0, auth_2.getAuth)(),
    // API REST → bearer token only, pas de login page UI.
    mode: "bearer",
    allow: (user) => user !== null, // tout utilisateur Firebase authentifié
});
// defineRoute typé pour toute l'app
exports.api = apis_js_1.apis.toFunctions(routes_1.routes, https_1.onRequest, {
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
//# sourceMappingURL=index.js.map