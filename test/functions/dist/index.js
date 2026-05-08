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
exports.history = exports.sync = exports.crud = exports.admin = exports.server = void 0;
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
const postSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    userId: zod_1.default.string().nullish(),
    address: zod_1.default.object({ street: zod_1.default.string(), city: zod_1.default.string() }),
    title: zod_1.default.string().nullish(),
    content: zod_1.default.string().nullish(),
    status: zod_1.default.enum(["draft", "published"]),
    comment: zod_1.default.string().nullish(),
    views: zod_1.default.number(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
const userSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    email: zod_1.default.string(),
    name: zod_1.default.string().nullable(),
    age: zod_1.default.number(),
    isActive: zod_1.default.boolean().nullable(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
const CommentModel = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    postId: zod_1.default.string(),
    userId: zod_1.default.string(),
    content: zod_1.default.string(),
    likes: zod_1.default.number(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
});
const ComputeSchema = zod_1.default.object({
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
    users: (0, firestore_repo_service_1.createRepositoryConfig)(userSchema)({
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
    posts: (0, firestore_repo_service_1.createRepositoryConfig)(postSchema)({
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
    comments: (0, firestore_repo_service_1.createRepositoryConfig)(CommentModel)({
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
    compute: (0, firestore_repo_service_1.createRepositoryConfig)(ComputeSchema)({
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
const repos = (0, firestore_repo_service_1.createRepositoryMapping)(db, repositoryMappingWithRelations);
exports.server = (0, https_1.onRequest)(async (req, res) => {
    try {
        const ressourcesSizes = 1;
        // 1. Création d'un user
        const user = await repos.users.create({
            age: 28,
            email: "john.doe@example.com",
            isActive: true,
            name: "John Doe",
        });
        console.log("Created User:", user);
        console.log("User docId:", user.docId);
        console.log("User documentPath:", user.documentPath);
        const g = await repos.posts.history?.list("examplePostId");
        g?.forEach((h) => console.log("Post history entry:", h));
        const r = await repos.posts.history?.byField("examplePostId", "address");
        r?.forEach((h) => console.log("Post history by field:", h));
        // 2. Récupération de ce user par docId
        const fetchedUser = await repos.users.get.byDocId(user.docId);
        console.log("Fetched User:", fetchedUser);
        // 3. Création de 5 posts associés à ce user via batch
        const postBatch = repos.posts.batch.create();
        for (let i = 1; i <= 5 * ressourcesSizes; i++) {
            const postId = `post-${i}-${Date.now()}`;
            const postData = {
                address: { street: `${i * 100} Main St`, city: "Anytown" },
                content: `This is post number ${i} by ${user.name}.`,
                status: (i % 2 === 0 ? "published" : "draft"),
                title: `Post ${i}`,
                userId: user.docId,
                views: i * Math.floor(Math.random() * 100),
            };
            postBatch.set(postId, postData);
        }
        await postBatch.commit();
        const firstPost = await repos.posts.get.byUserId(user.docId);
        if (!firstPost) {
            throw new Error("No posts were created.");
        }
        const commentBatch = repos.comments.batch.create();
        const commentsData = [];
        for (let i = 1; i <= 3 * ressourcesSizes; i++) {
            const commentId = `comment-${i}-${Date.now()}`;
            const commentData = {
                postId: firstPost?.docId,
                userId: user.docId,
                content: `This is comment number ${i} on the post.`,
                likes: i * 5,
            };
            commentBatch.set(firstPost.docId, commentId, commentData);
            commentsData.push({ docId: commentId, ...commentData });
        }
        await commentBatch.commit();
        console.log("Created Comments via batch:", commentsData);
        // 5. Récupération des posts par userId
        const userPosts = await repos.posts.get.byUserId(user.docId);
        console.log("User Posts:", userPosts);
        // 6. Récupération des comments par postId
        const postComments = await repos.comments.get.byPostId(firstPost.docId);
        console.log("Post Comments:", postComments);
        res.json({
            message: "Success!",
            user: fetchedUser,
            posts: userPosts,
            comments: postComments,
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
const servers = (0, firestore_repo_service_1.createServers)(repos, {
    onRequest: https_1.onRequest,
    httpsOptions: { ingressSettings: "ALLOW_ALL", invoker: "public" },
});
exports.admin = servers.admin({
    auth: (0, auth_1.firebaseAuth)({
        getAuth: () => (0, auth_2.getAuth)(), // No auth in this example, but you can plug in Firebase Auth here
        mode: "bearer",
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
        getAuth: auth_2.getAuth,
        mode: "bearer",
        allow: (u) => ({ uid: u.uid, role: u.claims.role ?? "user" }),
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
        auth: {
            type: "basic",
            realm: "Admin Area",
            username: "admin",
            password: "password",
        },
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
//# sourceMappingURL=index.js.map