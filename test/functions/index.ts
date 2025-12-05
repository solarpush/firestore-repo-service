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
  title: string;
  content: string;
  status: "draft" | "published";
  views: number;
  createdAt: Date;
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
    refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
    autoFields: {
      docId: (docRef) => docRef.id,
      documentPath: (docRef) => docRef.path,
    },
  }),

  posts: createRepositoryConfig<PostModel>()({
    path: "posts",
    isGroup: false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys: ["status", "userId"] as const,
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
  }),
};

// Step 2: Build relations with full type validation
const repositoryMappingWithRelations = buildRepositoryRelations(
  repositoryMapping,
  {
    posts: {
      userId: { repo: "users", key: "docId", type: "one" as const },
    },
  }
);

// Step 3: Create the repository mapping
const repos = createRepositoryMapping(db, repositoryMappingWithRelations);
export const server = onRequest(async (req, res) => {
  const users = await repos.users.create({
    age: 30,
    createdAt: new Date(),
    docId: "user1",
    email: "user1@example.com",
    isActive: true,
    name: "User One",
    updatedAt: new Date(),
  });
  console.log("Created User:", users);
  res.json({ message: "Hello from Firebase Functions!", users });
});
