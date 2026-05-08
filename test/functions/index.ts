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

const postSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  userId: z.string().nullish(),
  address: z.object({ street: z.string(), city: z.string() }),
  title: z.string().nullish(),
  content: z.string().nullish(),
  status: z.enum(["draft", "published"]),
  comment: z.string().nullish(),
  views: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const userSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  age: z.number(),
  isActive: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const CommentModel = z.object({
  docId: z.string(),
  documentPath: z.string(),
  postId: z.string(),
  userId: z.string(),
  content: z.string(),
  likes: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ComputeSchema = z.object({
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
const repos = createRepositoryMapping(db, repositoryMappingWithRelations);

export const server = onRequest(async (req, res) => {
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
        status: (i % 2 === 0 ? "published" : "draft") as "draft" | "published",
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
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { getAuth } from "firebase-admin/auth";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";

const servers = createServers(repos, {
  onRequest,
  httpsOptions: { ingressSettings: "ALLOW_ALL", invoker: "public" },
});

export const admin = servers.admin({
  auth: (req, res, next) => {
    const authHeader = req.headers?.authorization;
    const auth = getAuth();
    auth.
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    auth
      .verifyIdToken(idToken)
      .then((decodedToken) => {
        (req as any).user = decodedToken;
        next();
      })
      .catch(() => {
        res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
        return res.status(401).json({ error: "Unauthorized" });
      });
  },
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
  repos: {
    posts: {
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
export const history = servers.history({
  deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
  defaults: { ttl: { days: 365 } },
});
