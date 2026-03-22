import { BigQuery } from "@google-cloud/bigquery";
import {
  buildRepositoryRelations,
  createAdminServer,
  createCrudServer,
  createRepositoryConfig,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { createFirestoreSync } from "@lpdjs/firestore-repo-service/sync";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/https";
import z from "zod";
// IMPORTANT: Configurer les variables d'environnement AVANT d'initialiser
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Supprimer le warning de métadonnées GCP
process.env.GOOGLE_CLOUD_PROJECT = "demo-no-project";
process.env.GCLOUD_PROJECT = "demo-no-project";

// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (demo-no-project)
initializeApp({
  projectId: "demo-no-project",
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
  views: z.number().array(),
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
        views: [i * 10],
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
export const admin = onRequest(
  createAdminServer({
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
  }),
);
const crudServer = createCrudServer({
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
      { url: "http://127.0.0.1:5001/demo-no-project/us-central1/crud" },
    ],
    auth: "bearer",
  },
});
export const crud = onRequest(crudServer);

/**
 * Test endpoint for CRUD server - runs all operations and returns results.
 */
export const testCrud = onRequest(async (req, res) => {
  const baseUrl = `http://localhost:5001/demo-no-project/us-central1/crud`;
  const results: Record<string, unknown> = {};

  try {
    // 1. CREATE - POST /posts
    console.log("1. Testing CREATE...");
    const createRes = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Post from CRUD",
        content: "This is a test post created via CRUD API",
        status: "draft",
        address: { street: "123 Test St", city: "Test City" },
        views: [1, 2, 3],
        userId: "test-user-123",
      }),
    });
    const createData: any = await createRes.json();
    results.create = { status: createRes.status, data: createData };
    const createdId = createData.data?.docId;
    console.log("Created:", createdId);

    if (!createdId) {
      throw new Error("CREATE failed - no docId returned");
    }

    // 2. GET by ID - GET /posts/:id
    console.log("2. Testing GET by ID...");
    const getRes = await fetch(`${baseUrl}/posts/${createdId}`);
    const getData: any = await getRes.json();
    results.getById = { status: getRes.status, data: getData };

    // 3. LIST - GET /posts
    console.log("3. Testing LIST...");
    const listRes = await fetch(`${baseUrl}/posts?pageSize=5`);
    const listData: any = await listRes.json();
    results.list = {
      status: listRes.status,
      itemCount: listData.data?.items?.length,
      hasNextPage: listData.data?.hasNextPage,
      nextCursor: listData.data?.nextCursor,
    };

    // 4. LIST with filters - GET /posts?status=draft
    console.log("4. Testing LIST with filters...");
    const filterRes = await fetch(`${baseUrl}/posts?status=draft&pageSize=5`);
    const filterData: any = await filterRes.json();
    results.listFiltered = {
      status: filterRes.status,
      itemCount: filterData.data?.items?.length,
    };

    // 5. QUERY (POST) - POST /posts/query
    console.log("5. Testing QUERY (POST)...");
    const queryRes = await fetch(`${baseUrl}/posts/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where: [["status", "==", "draft"]],
        orderBy: [{ field: "createdAt", direction: "desc" }],
        pageSize: 5,
      }),
    });
    const queryData: any = await queryRes.json();
    results.query = {
      status: queryRes.status,
      itemCount: queryData.data?.items?.length,
      hasNextPage: queryData.data?.hasNextPage,
    };

    // 6. Pagination with cursor - use cursor from list
    if (listData.data?.nextCursor) {
      console.log("6. Testing pagination with cursor...");
      const cursorStr = JSON.stringify(listData.data.nextCursor);
      const page2Res = await fetch(
        `${baseUrl}/posts?pageSize=5&cursor=${encodeURIComponent(cursorStr)}`,
      );
      const page2Data: any = await page2Res.json();
      results.pagination = {
        status: page2Res.status,
        itemCount: page2Data.data?.items?.length,
        hasPrevPage: page2Data.data?.hasPrevPage,
      };
    } else {
      results.pagination = { skipped: "No cursor available" };
    }

    // 7. UPDATE (PUT) - PUT /posts/:id
    console.log("7. Testing UPDATE (PUT)...");
    const updateRes = await fetch(`${baseUrl}/posts/${createdId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Updated Test Post",
        content: "Updated content via PUT",
        status: "published",
        address: { street: "456 New St", city: "New City" },
        views: [10, 20, 30],
      }),
    });
    const updateData: any = await updateRes.json();
    results.updatePut = { status: updateRes.status, data: updateData };

    // 8. UPDATE (PATCH) - PATCH /posts/:id
    console.log("8. Testing UPDATE (PATCH)...");
    const patchRes = await fetch(`${baseUrl}/posts/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Patched Title Only",
      }),
    });
    const patchData: any = await patchRes.json();
    results.updatePatch = { status: patchRes.status, data: patchData };

    // 9. Verify update - GET again
    console.log("9. Verifying updates...");
    const verifyRes = await fetch(`${baseUrl}/posts/${createdId}`);
    const verifyData: any = await verifyRes.json();
    results.verifyUpdate = {
      status: verifyRes.status,
      title: verifyData.data?.title,
      status_field: verifyData.data?.status,
    };

    // 10. DELETE - DELETE /posts/:id
    console.log("10. Testing DELETE...");
    const deleteRes = await fetch(`${baseUrl}/posts/${createdId}`, {
      method: "DELETE",
    });
    const deleteData: any = await deleteRes.json();
    results.delete = { status: deleteRes.status, data: deleteData };

    // 11. Verify deletion - GET should 404
    console.log("11. Verifying deletion...");
    const verify404Res = await fetch(`${baseUrl}/posts/${createdId}`);
    const verify404Data: any = await verify404Res.json();
    results.verifyDelete = {
      status: verify404Res.status,
      expected404: verify404Res.status === 404,
    };

    // Summary
    const allPassed =
      results.create &&
      (results.create as any).status === 201 &&
      (results.getById as any).status === 200 &&
      (results.list as any).status === 200 &&
      (results.updatePut as any).status === 200 &&
      (results.updatePatch as any).status === 200 &&
      (results.delete as any).status === 200 &&
      (results.verifyDelete as any).expected404;

    res.status(allPassed ? 200 : 500).json({
      success: allPassed,
      message: allPassed ? "All CRUD tests passed!" : "Some tests failed",
      results,
    });
  } catch (error) {
    console.error("Test error:", error);
    res.status(500).json({
      success: false,
      error: String(error),
      results,
    });
  }
});

// Firestore → BigQuery sync
import { PubSub } from "@google-cloud/pubsub";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";

export const sync = createFirestoreSync(repos, {
  deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "my-project" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
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
export const adminSync = onRequest(sync.functions.syncAdmin);
