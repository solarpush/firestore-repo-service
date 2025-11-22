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
    queryKeys: ["status"] as const,
    type: {} as PostModel,
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
  }),
} as const;

export const repos = createRepositoryMapping(db, repositoryMapping);

// ============================================
// Test Function - Modifiez cette fonction pour vos tests
// ============================================

async function test() {
  console.log("🧪 Starting sandbox test...\n");

  // Exemple 1: Pagination simple avec curseur
  console.log("📄 Test de pagination simple (10 par page):");
  const page1 = await repos.users.query.paginate({
    pageSize: 10,
    where: [{ field: "isActive", operator: "==", value: true }],
    orderBy: [{ field: "createdAt", direction: "desc" }],
  });

  console.log(`  - Page 1: ${page1.pageSize} utilisateurs`);
  console.log(`  - Plus de pages: ${page1.hasNextPage}`);
  page1.data.forEach((u) => console.log(`    • ${u.name} (${u.email})`));

  // Page suivante avec curseur
  if (page1.hasNextPage) {
    const page2 = await repos.users.query.paginate({
      pageSize: 10,
      cursor: page1.nextCursor,
      direction: "next",
      where: [{ field: "isActive", operator: "==", value: true }],
      orderBy: [{ field: "createdAt", direction: "desc" }],
    });
    console.log(`\n  - Page 2: ${page2.pageSize} utilisateurs`);
    page2.data.forEach((u) => console.log(`    • ${u.name} (${u.email})`));
    // Page suivante avec curseur
    if (page2.hasNextPage) {
      const page3 = await repos.users.query.paginate({
        pageSize: 10,
        cursor: page2.nextCursor,
        direction: "next",
        where: [{ field: "isActive", operator: "==", value: true }],
        orderBy: [{ field: "createdAt", direction: "desc" }],
      });
      console.log(`\n  - Page 3: ${page3.pageSize} utilisateurs`);
      page3.data.forEach((u) => console.log(`    • ${u.name} (${u.email})`));
      console.log(page3.hasNextPage);
    }
  }

  // Exemple 2: Itération automatique avec générateur
  console.log("\n🔄 Test d'itération avec générateur (5 par page):");
  let pageNum = 0;
  let totalUsers = 0;
  for await (const page of repos.users.query.paginateAll({
    pageSize: 5,
    where: [{ field: "isActive", operator: "==", value: true }],
    orderBy: [{ field: "createdAt", direction: "desc" }],
  })) {
    pageNum++;
    totalUsers += page.pageSize;
    console.log(
      `  - Page ${pageNum}: ${page.pageSize} utilisateurs (total: ${totalUsers})`
    );

    // Arrêter après 3 pages pour l'exemple
    if (pageNum >= 3) break;
  }

  console.log("\n✅ Sandbox test completed!");
}

// Auto-exécution
test().finally(() => {
  process.exit(0);
});
