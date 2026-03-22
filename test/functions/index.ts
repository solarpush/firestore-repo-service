import {
  buildRepositoryRelations,
  createAdminServer,
  createCrudServer,
  createRepositoryConfig,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/https";
import z from "zod";
// IMPORTANT: Configurer les variables d'environnement AVANT d'initialiser
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Supprimer le warning de métadonnées GCP
process.env.GOOGLE_CLOUD_PROJECT = "firestore-repo-services";
process.env.GCLOUD_PROJECT = "firestore-repo-services";

// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (firestore-repo-services)
initializeApp({
  projectId: "firestore-repo-services",
});

const db = getFirestore();

// ============================================
// Models (interfaces pour repos sans schema Zod)
// ============================================

// ============================================
// Zod Schemas
// ============================================

const postSchema = z.object({
  docId: z.string(),
  documentPath: z.string(),
  userId: z.string(),
  address: z.object({ street: z.string(), city: z.string() }),
  title: z.string(),
  content: z.string(),
  status: z.enum(["draft", "published"]),
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
    const userWithPosts = await repos.users.populate(
      { docId: user.docId },
      {
        relation: "docId",
        select: ["docId", "title", "status"],
      },
    );
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
    console.log(
      "Paginated posts with comments and user:",
      paginatedPostsWithComments.data,
    );

    // 10. Pagination des comments avec include pour récupérer le post et l'user
    const paginatedCommentsWithRelations = await repos.comments.query.paginate({
      pageSize: 10,
      include: ["postId", { relation: "userId", select: ["email"] }], // Inclure le post ET l'user
    });
    console.log(
      "Paginated comments with post and user:",
      paginatedCommentsWithRelations.data,
    );

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
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: String(error) });
  }
});
const adminHandler = createAdminServer({
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
export const admin = onRequest(adminHandler.httpsOptions!, adminHandler);
const crudServer = createCrudServer({
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
export const crud = onRequest(crudServer.httpsOptions!, crudServer);

// Firestore → BigQuery sync
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import { createFirestoreSync } from "@lpdjs/firestore-repo-service/sync";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";

export const sync = createFirestoreSync(repos, {
  deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "firestore-repo-services" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  admin: {
    onRequest,
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
