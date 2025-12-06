/**
 * Test setup - Initialize Firebase Admin with Firestore Emulator
 */
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import {
  buildRepositoryRelations,
  createRepositoryConfig,
  createRepositoryMapping,
} from "../index";

// ============================================
// Emulator Configuration
// ============================================

const EMULATOR_HOST = "localhost:8080";
const PROJECT_ID = "demo-no-project";

// Configure environment BEFORE initializing
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

// ============================================
// Models
// ============================================

export interface UserModel {
  docId: string;
  documentPath: string;
  email: string;
  name: string;
  age: number;
  isActive: boolean;
  tags: string[];
  metadata: { role: string; level: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface PostModel {
  docId: string;
  documentPath: string;
  userId: string;
  title: string;
  content: string;
  status: "draft" | "published" | "archived";
  views: number;
  likes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentModel {
  docId: string;
  documentPath: string;
  postId: string;
  userId: string;
  content: string;
  likes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryModel {
  docId: string;
  documentPath: string;
  name: string;
  slug: string;
  postCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Emulator Helpers
// ============================================

/**
 * Check if Firestore emulator is available
 */
export async function checkEmulatorAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${EMULATOR_HOST}/`);
    return response.ok || response.status === 200 || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Wait for emulator to be available with retries
 */
export async function waitForEmulator(
  maxRetries = 30,
  delayMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkEmulatorAvailable()) {
      return true;
    }
    console.log(`Waiting for emulator... (${i + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Clear all data in the emulator
 */
export async function clearEmulatorData(): Promise<void> {
  try {
    await fetch(
      `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
      { method: "DELETE" }
    );
  } catch (error) {
    console.warn("Failed to clear emulator data:", error);
  }
}

/**
 * Export index usage from the emulator
 */
export async function exportIndexUsage(): Promise<any> {
  try {
    const response = await fetch(
      `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}:indexUsage?database=projects/${PROJECT_ID}/databases/(default)`
    );
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (error) {
    console.warn("Failed to export index usage:", error);
    return null;
  }
}

// ============================================
// Repository Setup
// ============================================

let db: Firestore | null = null;

/**
 * Initialize Firebase and return Firestore instance
 */
export function initializeFirestore(): Firestore {
  if (db) return db;

  // Clean up existing apps
  const apps = getApps();
  for (const app of apps) {
    deleteApp(app);
  }

  // Initialize new app
  initializeApp({ projectId: PROJECT_ID });
  db = getFirestore();

  return db;
}

/**
 * Create repository mapping for tests
 */
export function createTestRepositories(firestore: Firestore) {
  // Step 1: Build the base mapping
  const repositoryMapping = {
    users: createRepositoryConfig<UserModel>()({
      path: "users",
      isGroup: false,
      foreignKeys: ["docId", "email"] as const,
      queryKeys: ["name", "isActive", "age"] as const,
      documentKey: "docId",
      pathKey: "documentPath",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      refCb: (db: Firestore, docId: string) =>
        db.collection("users").doc(docId),
    }),

    posts: createRepositoryConfig<PostModel>()({
      path: "posts",
      isGroup: false,
      foreignKeys: ["docId", "userId"] as const,
      queryKeys: ["status", "userId", "views"] as const,
      documentKey: "docId",
      pathKey: "documentPath",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      refCb: (db: Firestore, docId: string) =>
        db.collection("posts").doc(docId),
    }),

    comments: createRepositoryConfig<CommentModel>()({
      path: "comments",
      isGroup: true,
      foreignKeys: ["docId", "postId", "userId"] as const,
      queryKeys: ["postId", "userId", "likes"] as const,
      documentKey: "docId",
      pathKey: "documentPath",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      refCb: (db: Firestore, postId: string, docId: string) =>
        db.collection("posts").doc(postId).collection("comments").doc(docId),
    }),

    categories: createRepositoryConfig<CategoryModel>()({
      path: "categories",
      isGroup: false,
      foreignKeys: ["docId", "slug"] as const,
      queryKeys: ["name", "postCount"] as const,
      documentKey: "docId",
      pathKey: "documentPath",
      createdKey: "createdAt",
      updatedKey: "updatedAt",
      refCb: (db: Firestore, docId: string) =>
        db.collection("categories").doc(docId),
    }),
  };

  // Step 2: Build relations
  const repositoryMappingWithRelations = buildRepositoryRelations(
    repositoryMapping,
    {
      users: {
        docId: { repo: "posts", key: "userId", type: "many" as const },
      },
      posts: {
        userId: { repo: "users", key: "docId", type: "one" as const },
        docId: { repo: "comments", key: "postId", type: "many" as const },
      },
      comments: {
        postId: { repo: "posts", key: "docId", type: "one" as const },
        userId: { repo: "users", key: "docId", type: "one" as const },
      },
    }
  );

  // Step 3: Create the repository mapping
  return createRepositoryMapping(firestore, repositoryMappingWithRelations);
}

export type TestRepositories = ReturnType<typeof createTestRepositories>;
