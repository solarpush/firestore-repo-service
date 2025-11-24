import * as admin from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { createRepositoryConfig, createRepositoryMapping } from "../index";

// IMPORTANT: Configurer les variables d'environnement AVANT d'initialiser
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Supprimer le warning de métadonnées GCP
process.env.GOOGLE_CLOUD_PROJECT = "demo-no-project";
process.env.GCLOUD_PROJECT = "demo-no-project";

// Initialize Firebase Admin avec l'émulateur
// IMPORTANT: Utiliser le même projectId que l'émulateur (demo-no-project)
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
    queryKeys: ["status"] as const,
    type: {} as PostModel,
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
  }),
} as const;

export const repos = createRepositoryMapping(db, repositoryMapping);

// ============================================
// Test Functions
// ============================================

async function testCreate() {
  console.log("\n=== Testing Create ===");

  const newUser = await repos.users.create({
    email: "test@example.com",
    name: "Test User",
    age: 25,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log("Created user:", newUser);
  return newUser.docId;
}

async function testGet(userId: string) {
  console.log("\n=== Testing Get ===");

  const user = await repos.users.get.byDocId(userId);
  console.log("Got user by ID:", user);

  const userByEmail = await repos.users.get.byEmail("test@example.com");
  console.log("Got user by email:", userByEmail);
}

async function testUpdate(userId: string) {
  console.log("\n=== Testing Update ===");

  const updated = await repos.users.update(userId, {
    age: 26,
    name: "Updated User",
    updatedAt: new Date(),
  });

  console.log("Updated user:", updated);
}

async function testQuery() {
  console.log("\n=== Testing Query ===");

  const activeUsers = await repos.users.query.byIsActive(true);
  console.log("Active users:", activeUsers.length);

  const allUsers = await repos.users.query.getAll();
  console.log("All users:", allUsers.length);
}

async function testGetAll() {
  console.log("\n=== Testing GetAll ===");

  const allUsers = await repos.users.query.getAll({
    orderBy: [{ field: "createdAt", direction: "desc" }],
  });

  console.log("All users (ordered):", allUsers);
}

async function testOnSnapshot() {
  console.log("\n=== Testing OnSnapshot ===");

  return new Promise<void>((resolve) => {
    let count = 0;
    const unsubscribe = repos.users.query.onSnapshot(
      {
        where: [{ field: "isActive" as any, operator: "==", value: true }],
      },
      (users: UserModel[]) => {
        console.log(`Snapshot update ${++count}:`, users.length, "users");
        if (count >= 2) {
          unsubscribe();
          resolve();
        }
      },
      (error: Error) => {
        console.error("Snapshot error:", error);
        unsubscribe();
        resolve();
      }
    );

    // Trigger an update after a short delay
    setTimeout(async () => {
      await repos.users.create({
        email: "snapshot-test@example.com",
        name: "Snapshot Test",
        age: 30,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }, 1000);
  });
}

async function testAggregation() {
  console.log("\n=== Testing Aggregation ===");

  const count = await repos.users.aggregate.count({
    where: [{ field: "isActive" as any, operator: "==", value: true }],
  });
  console.log("Active users count:", count);
}

async function testDelete(userId: string) {
  console.log("\n=== Testing Delete ===");

  await repos.users.delete(userId);
  console.log("Deleted user:", userId);
}

// ============================================
// Run All Tests
// ============================================

async function runTests() {
  let userId: string = "jaCUk6kZjg6O4tBkH45V";
  try {
    console.log("🚀 Starting tests with Firestore Emulator...");

    // Create
    userId = await testCreate();
    console.log("Created user with ID:", userId);
    // Get
    await testGet(userId);

    // Update
    await testUpdate(userId);

    // Query
    await testQuery();

    // GetAll
    await testGetAll();

    // OnSnapshot
    await testOnSnapshot();

    // Aggregation
    await testAggregation();

    // Delete - Commenté pour garder les données dans l'émulateur
    await testDelete(userId);

    console.log("\n✅ All tests completed successfully!");
    console.log(
      "\n📊 Data is now visible in Firestore Emulator UI (http://localhost:4000)"
    );
    console.log("📝 Check the 'users' collection in the emulator");
    console.log("Press Ctrl+C to exit\n");

    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
}

runTests();
