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
exports.sync = exports.crud = exports.admin = exports.server = void 0;
const firestore_repo_service_1 = require("@lpdjs/firestore-repo-service");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/https");
const zod_1 = __importDefault(require("zod"));
// IMPORTANT: Configurer les variables d'environnement AVANT d'initialiser
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Supprimer le warning de métadonnées GCP
process.env.GOOGLE_CLOUD_PROJECT = "firestore-repo-services";
process.env.GCLOUD_PROJECT = "firestore-repo-services";
// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (firestore-repo-services)
(0, app_1.initializeApp)({
    projectId: "firestore-repo-services",
});
const db = (0, firestore_1.getFirestore)();
db.settings({ preferRest: true });
// ============================================
// Models (interfaces pour repos sans schema Zod)
// ============================================
// ============================================
// Zod Schemas
// ============================================
const postSchema = zod_1.default.object({
    docId: zod_1.default.string(),
    documentPath: zod_1.default.string(),
    userId: zod_1.default.string(),
    address: zod_1.default.object({ street: zod_1.default.string(), city: zod_1.default.string() }),
    title: zod_1.default.string(),
    content: zod_1.default.string(),
    status: zod_1.default.enum(["draft", "published"]),
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
        // 2. Récupération de ce user par docId
        const fetchedUser = await repos.users.get.byDocId(user.docId);
        console.log("Fetched User:", fetchedUser);
        // 3. Création de 5 posts associés à ce user via batch
        const postBatch = repos.posts.batch.create();
        for (let i = 1; i <= 5; i++) {
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
        for (let i = 1; i <= 3; i++) {
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
        // 7. Récupération du user avec populate pour obtenir ses posts associés
        const userWithPosts = await repos.users.populate({ docId: user.docId }, {
            relation: "docId",
            select: ["docId", "title", "status"],
        });
        console.log("User with populated posts:", userWithPosts);
        console.log("Populated posts data:", userWithPosts.populated.docId);
        // 8. Récupération d'un post avec ses comments via populate
        const postWithComments = await repos.posts.populate(firstPost, "docId");
        console.log("Post with populated comments:", postWithComments);
        console.log("Populated comments:", postWithComments.populated.docId);
        // 9. Pagination des posts avec include pour récupérer les comments de chaque post
        const paginatedPostsWithComments = await repos.posts.query.paginate({
            pageSize: 10,
            include: ["docId", { relation: "userId", select: ["docId"] }], // Inclure comments ET user
            orWhere: [["userId", "==", user.docId]], // Filtrer pour n'avoir que les posts de notre user
        });
        console.log("Paginated posts with comments and user:", paginatedPostsWithComments.data);
        // 10. Pagination des comments avec include pour récupérer le post et l'user
        const paginatedCommentsWithRelations = await repos.comments.query.paginate({
            pageSize: 10,
            include: ["postId", { relation: "userId", select: ["email"] }], // Inclure le post ET l'user
        });
        console.log("Paginated comments with post and user:", paginatedCommentsWithRelations.data);
        res.json({
            message: "Success!",
            user: fetchedUser,
            posts: userPosts,
            comments: postComments,
            userWithPopulatedPosts: userWithPosts,
            postWithPopulatedComments: postWithComments,
            paginatedPostsWithComments: paginatedPostsWithComments.data,
            paginatedCommentsWithRelations: paginatedCommentsWithRelations.data,
        });
    }
    catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: String(error) });
    }
});
const adminHandler = (0, firestore_repo_service_1.createAdminServer)({
    httpsOptions: { invoker: "public" },
    auth: {
        type: "basic",
        realm: "Admin Area",
        username: "admin",
        password: "password",
    },
    basePath: "/",
    repos: {
        posts: {
            repo: repos.posts,
            path: "posts",
            fieldsConfig: {
                title: ["create", "mutable", "filterable"],
                content: ["create", "mutable"],
                status: ["mutable", "filterable"],
                address: ["create", "mutable", "filterable"],
                views: ["create", "mutable", "filterable"],
                userId: ["filterable"],
            },
            relationalFields: [
                { key: "userId", column: "Author" },
                { key: "docId", column: "Comments" },
            ],
            allowDelete: true,
        },
        users: {
            repo: repos.users,
            path: "users",
            allowDelete: false,
            fieldsConfig: {
                name: ["create", "mutable", "filterable"],
                email: ["create", "mutable", "filterable"],
                age: ["create", "mutable", "filterable"],
                isActive: ["create", "mutable", "filterable"],
                docId: ["filterable"],
            },
            relationalFields: [{ key: "docId", column: "Posts" }],
        },
        comments: {
            repo: repos.comments,
            path: "comments",
            allowDelete: true,
            fieldsConfig: {
                docId: ["create", "filterable"],
                likes: ["filterable"],
                content: ["create", "mutable"],
            },
            relationalFields: [],
        },
    },
});
exports.admin = (0, https_1.onRequest)(adminHandler.httpsOptions, adminHandler);
const crudServer = (0, firestore_repo_service_1.createCrudServer)({
    httpsOptions: { invoker: "public" },
    basePath: "/",
    repos: {
        posts: {
            repo: repos.posts,
            path: "posts",
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
            repo: repos.users,
            path: "users",
            allowDelete: true,
            fieldsConfig: {
                name: ["create", "mutable", "filterable"],
                email: ["create", "mutable", "filterable"],
                age: ["create", "mutable", "filterable"],
                isActive: ["create", "mutable", "filterable"],
                docId: ["filterable"],
            },
        },
        comments: {
            repo: repos.comments,
            path: "comments",
            allowDelete: true,
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
exports.crud = (0, https_1.onRequest)(crudServer.httpsOptions, crudServer);
// Firestore → BigQuery sync
const bigquery_1 = require("@google-cloud/bigquery");
const pubsub_1 = require("@google-cloud/pubsub");
const sync_1 = require("@lpdjs/firestore-repo-service/sync");
const bigquery_2 = require("@lpdjs/firestore-repo-service/sync/bigquery");
const firestoreTriggers = __importStar(require("firebase-functions/v2/firestore"));
const pubsubHandler = __importStar(require("firebase-functions/v2/pubsub"));
exports.sync = (0, sync_1.createFirestoreSync)(repos, {
    deps: { firestoreTriggers, pubsubHandler, pubsub: new pubsub_1.PubSub() },
    adapter: new bigquery_2.BigQueryAdapter({
        bigquery: new bigquery_1.BigQuery({ projectId: "firestore-repo-services" }),
        datasetId: "firestore_sync",
    }),
    topicPrefix: "firestore-sync",
    autoMigrate: true,
    admin: {
        onRequest: https_1.onRequest,
        httpsOptions: { invoker: "public" },
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
            columnMap: { docId: "comment_id" },
            triggerPath: "posts/{postId}/comments/{docId}",
        },
    },
});
//# sourceMappingURL=index.js.map