import {
  buildRepositoryRelations,
  createRepositoryConfig,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/https";
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
// Models
// ============================================

interface UserModel {
  docId: string;

  documentPath: string;
  email: string;
  name: string;
  age: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface PostModel {
  docId: string;
  documentPath: string;
  userId: string;
  address: { street: string; city: string };
  title: string;
  content: string;
  status: "draft" | "published";
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Repository Configuration
// ============================================

// Step 1: Build the base mapping
const repositoryMapping = {
  users: createRepositoryConfig<UserModel>()({
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

  posts: createRepositoryConfig<PostModel>()({
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
};

// Step 2: Build relations with full type validation
const repositoryMappingWithRelations = buildRepositoryRelations(
  repositoryMapping,
  {
    // Un user a plusieurs posts (via docId → userId)
    users: {
      docId: { repo: "posts", key: "userId", type: "many" as const },
    },
    // Un post appartient à un user (via userId → docId)
    posts: {
      userId: { repo: "users", key: "docId", type: "one" as const },
    },
  }
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
    const postsData = [];
    for (let i = 1; i <= 5; i++) {
      const postId = `post-${i}-${Date.now()}`;
      const postData = {
        address: { street: `${i * 100} Main St`, city: "Anytown" },
        content: `This is post number ${i} by ${user.name}.`,
        createdAt: new Date(),
        status: (i % 2 === 0 ? "published" : "draft") as "draft" | "published",
        title: `Post ${i}`,
        userId: user.docId,
        views: i * 10,
      };
      postBatch.set(postId, postData);
      postsData.push({ docId: postId, ...postData });
    }
    await postBatch.commit();
    console.log("Created Posts via batch:", postsData);

    // 4. Récupération des posts par userId
    const userPosts = await repos.posts.get.byUserId(user.docId);
    console.log("User Posts:", userPosts);

    // 5. Récupération du user avec populate pour obtenir ses posts associés
    const userWithPosts = await repos.users.populate(user, "docId");
    console.log("User with populated posts:", userWithPosts);
    console.log("Populated posts data:", userWithPosts.populated.posts);

    // 6. Pagination avec include pour récupérer les users avec leurs posts
    const paginatedUsersWithPosts = await repos.users.query.paginate({
      pageSize: 10,
      include: ["docId"], // Inclure la relation docId -> posts
    });
    console.log("Paginated users with posts:", paginatedUsersWithPosts.data);

    // 7. Pagination des posts avec include pour récupérer l'user de chaque post
    const paginatedPostsWithUsers = await repos.posts.query.paginate({
      pageSize: 10,
      include: ["userId"], // Inclure la relation userId -> users
    });
    console.log("Paginated posts with users:", paginatedPostsWithUsers.data);

    res.json({
      message: "Success!",
      user: fetchedUser,
      posts: userPosts,
      userWithPopulatedPosts: userWithPosts,
      paginatedUsersWithPosts: paginatedUsersWithPosts.data,
      paginatedPostsWithUsers: paginatedPostsWithUsers.data,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: String(error) });
  }
});
