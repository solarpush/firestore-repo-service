import * as admin from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { createRepositoryConfig, createRepositoryMapping } from "../index";

// IMPORTANT: Configurer les variables d'environnement AVANT d'initialiser
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Supprimer le warning de métadonnées GCP
process.env.GOOGLE_CLOUD_PROJECT = "demo-no-project";
process.env.GCLOUD_PROJECT = "demo-no-project";

// Initialize Firebase Admin avec l'émulateur
admin.initializeApp({
  projectId: "demo-no-project",
});

const db = getFirestore();

// ============================================
// Models
// ============================================

interface UserModel {
  docId: string;
  email: string;
  name: string;
  age: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface PostModel {
  docId: string;
  userId: string;
  title: string;
  content: string;
  status: "draft" | "published";
  views: number;
  createdAt: Date;
}

// ============================================
// Repository Configuration
// ============================================

const repositoryMapping = {
  users: createRepositoryConfig({
    path: "users",
    isGroup: false,
    foreignKeys: ["docId", "email"] as const,
    queryKeys: ["name", "isActive"] as const,
    type: {} as UserModel,
    refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
  }),

  posts: createRepositoryConfig({
    path: "posts",
    isGroup: false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys: ["status", "userId"] as const,
    type: {} as PostModel,
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
    relationalKeys: {},
  }),
} as const;

export const repos = createRepositoryMapping(db, repositoryMapping);

// ============================================
// Test Function - Modifiez cette fonction pour vos tests
// ============================================

async function test() {
  console.log("🧪 Starting sandbox test...\n");

  // Test 1: Créer des utilisateurs
  console.log("👤 Création d'utilisateurs de test:");
  const user1 = await repos.users.create({
    name: "Alice",
    email: "alice@test.com",
    age: 25,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`  ✅ User créé: ${user1.name} (${user1.docId})`);

  const user2 = await repos.users.create({
    name: "Bob",
    email: "bob@test.com",
    age: 30,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`  ✅ User créé: ${user2.name} (${user2.docId})`);

  // Test 2: Créer des posts liés aux users
  console.log("\n📝 Création de posts:");
  const post1 = await repos.posts.create({
    userId: user1.docId,
    title: "Premier post d'Alice",
    content: "Contenu du post",
    status: "published",
    views: 42,
    createdAt: new Date(),
  });
  console.log(`  ✅ Post créé: ${post1.title} par userId=${post1.userId}`);

  const post2 = await repos.posts.create({
    userId: user2.docId,
    title: "Post de Bob",
    content: "Un autre contenu",
    status: "draft",
    views: 10,
    createdAt: new Date(),
  });
  console.log(`  ✅ Post créé: ${post2.title} par userId=${post2.userId}`);

  // Test 3: Populate one-to-one (post -> user)
  console.log("\n🔗 Test populate (one-to-one):");
  const postWithUser = await repos.posts.populate(post1, "userId");
  console.log(`  Post: "${postWithUser.title}"`);
  console.log(
    `  Auteur: ${postWithUser.userId?.name} (${postWithUser.userId?.email})`
  );

  // Test 4: Query posts par userId
  console.log("\n🔍 Query posts par userId:");
  const alicePosts = await repos.posts.query.byUserId(user1.docId);
  console.log(`  Alice a ${alicePosts.length} post(s)`);
  alicePosts.forEach((p) => console.log(`    • ${p.title}`));

  // Test 5: Populate multiple posts
  console.log("\n🔗 Populate plusieurs posts:");
  const allPosts = await repos.posts.query.getAll();
  console.log(`  Total: ${allPosts.length} posts`);
  for (const post of allPosts) {
    const populated = await repos.posts.populate(post, "userId");
    console.log(
      `  • "${populated.title}" par ${populated.userId?.name || "unknown"}`
    );
  }

  console.log("\n✅ Sandbox test completed!");
}

// Auto-exécution
test().finally(() => {
  process.exit(0);
});
