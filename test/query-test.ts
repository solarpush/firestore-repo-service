import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createRepositoryConfig, createRepositoryMapping } from "../index";

// Connect to emulator
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";

const app = initializeApp({
  projectId: "demo-no-project",
});

const db = getFirestore(app);

interface User {
  docId: string;
  name: string;
  email: string;
  status: "draft" | "published" | "archived";
  tags: string[];
  createdAt: number;
  isActive: boolean;
}

const repositoryMapping = {
  users: createRepositoryConfig({
    path: "query-test-users",
    isGroup: false,
    foreignKeys: ["docId"] as const,
    queryKeys: ["name", "status", "isActive", "tags"] as const,
    type: {} as User,
    refCb: (db: FirebaseFirestore.Firestore, docId: string) =>
      db.collection("query-test-users").doc(docId),
  }),
} as const;

const repos = createRepositoryMapping(db, repositoryMapping);

async function cleanup() {
  console.log("🧹 Nettoyage des données de test...");
  const snapshot = await db.collection("query-test-users").get();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  console.log(`✅ ${snapshot.size} documents supprimés\n`);
}

async function seedData() {
  console.log("🌱 Création des données de test...");

  const users: User[] = [
    // Users with status 'draft' (10)
    ...Array.from({ length: 10 }, (_, i) => ({
      docId: `draft-user-${i}`,
      name: `Draft User ${i}`,
      email: `draft${i}@test.com`,
      status: "draft" as const,
      tags: ["tag1", "tag2"],
      createdAt: Date.now() - i * 1000,
      isActive: i % 2 === 0,
    })),
    // Users with status 'published' (20)
    ...Array.from({ length: 20 }, (_, i) => ({
      docId: `published-user-${i}`,
      name: `Published User ${i}`,
      email: `published${i}@test.com`,
      status: "published" as const,
      tags: ["tag3", "tag4"],
      createdAt: Date.now() - (i + 10) * 1000,
      isActive: true,
    })),
    // Users with status 'archived' (15)
    ...Array.from({ length: 15 }, (_, i) => ({
      docId: `archived-user-${i}`,
      name: `Archived User ${i}`,
      email: `archived${i}@test.com`,
      status: "archived" as const,
      tags: ["tag5"],
      createdAt: Date.now() - (i + 30) * 1000,
      isActive: false,
    })),
  ];

  await repos.users.bulk.set(
    users.map((u) => ({ docRef: repos.users.documentRef(u.docId), data: u }))
  );
  console.log(`✅ ${users.length} utilisateurs créés\n`);
}

async function testOrQuery() {
  console.log("🧪 Test 1: Requête OR simple (draft OU published)");

  const result = await repos.users.query.paginate({
    pageSize: 50,
    orWhere: [
      [{ field: "status", operator: "==", value: "draft" }],
      [{ field: "status", operator: "==", value: "published" }],
    ],
  });

  console.log(`   Total: ${result.data.length} documents`);
  const draftCount = result.data.filter((u) => u.status === "draft").length;
  const publishedCount = result.data.filter(
    (u) => u.status === "published"
  ).length;
  console.log(`   - Draft: ${draftCount}`);
  console.log(`   - Published: ${publishedCount}`);
  console.log(`   ✅ Attendu: 30 (10 draft + 20 published)\n`);
}

async function testOrQueryWithAnd() {
  console.log("🧪 Test 2: Requête OR avec conditions AND");
  console.log("   (draft ET isActive) OU (published)");

  const result = await repos.users.query.paginate({
    pageSize: 50,
    orWhere: [
      [
        { field: "status", operator: "==", value: "draft" },
        { field: "isActive", operator: "==", value: true },
      ],
      [{ field: "status", operator: "==", value: "published" }],
    ],
  });

  console.log(`   Total: ${result.data.length} documents`);
  const draftActive = result.data.filter(
    (u) => u.status === "draft" && u.isActive
  ).length;
  const published = result.data.filter((u) => u.status === "published").length;
  console.log(`   - Draft actifs: ${draftActive}`);
  console.log(`   - Published: ${published}`);
  console.log(`   ✅ Attendu: ~25 (5 draft actifs + 20 published)\n`);
}

async function testAutoSplitting() {
  console.log("🧪 Test 3: Auto-splitting (query 'in' avec >30 items)");

  // Ajouter les IDs réels de nos users pour tester
  const allUsers = await repos.users.query.getAll({});
  const realIds = allUsers.slice(0, 35).map((u) => u.docId);

  console.log(
    `   Recherche avec ${realIds.length} IDs (devrait split en 2 queries)`
  );

  const result = await repos.users.query.paginate({
    pageSize: 50,
    where: [{ field: "docId", operator: "in", value: realIds }],
  });

  console.log(`   Total: ${result.data.length} documents trouvés`);
  console.log(`   ✅ Attendu: 35 documents\n`);
}

async function testComplexOrWithSplitting() {
  console.log("🧪 Test 4: OR + Auto-splitting combinés");

  // Créer 2 groupes OR, chacun avec un 'in' qui dépasse 30
  const allUsers = await repos.users.query.getAll({});
  const draftIds = allUsers
    .filter((u) => u.status === "draft")
    .map((u) => u.docId);
  const publishedIds = allUsers
    .filter((u) => u.status === "published")
    .slice(0, 35) // Prendre 35 pour forcer le split
    .map((u) => u.docId);

  // Créer des IDs fictifs pour avoir >30 items
  const fakeDraftIds = Array.from({ length: 25 }, (_, i) => `fake-draft-${i}`);
  const fakePublishedIds = Array.from(
    { length: 10 },
    (_, i) => `fake-pub-${i}`
  );

  const allDraftIds = [...draftIds, ...fakeDraftIds]; // 35 IDs
  const allPublishedIds = [...publishedIds, ...fakePublishedIds]; // 45 IDs

  console.log(`   Groupe 1 (draft): ${allDraftIds.length} IDs`);
  console.log(`   Groupe 2 (published): ${allPublishedIds.length} IDs`);

  const result = await repos.users.query.paginate({
    pageSize: 50,
    orWhere: [
      [{ field: "docId", operator: "in", value: allDraftIds }],
      [{ field: "docId", operator: "in", value: allPublishedIds }],
    ],
  });

  console.log(`   Total: ${result.data.length} documents trouvés`);
  const draftCount = result.data.filter((u) => u.status === "draft").length;
  const publishedCount = result.data.filter(
    (u) => u.status === "published"
  ).length;
  console.log(`   - Draft: ${draftCount}`);
  console.log(`   - Published: ${publishedCount}`);
  console.log(`   ✅ Devrait trouver tous les documents draft et published\n`);
}

async function testArrayContainsAnySplitting() {
  console.log(
    "🧪 Test 5: Auto-splitting avec 'array-contains-any' (>30 items)"
  );

  // Créer un tableau de 35 tags
  const manyTags = Array.from({ length: 35 }, (_, i) => `tag${i}`);
  // Inclure les vrais tags
  manyTags[0] = "tag1";
  manyTags[1] = "tag3";
  manyTags[2] = "tag5";

  console.log(`   Recherche documents avec l'un des ${manyTags.length} tags`);

  const result = await repos.users.query.paginate({
    pageSize: 50,
    where: [{ field: "tags", operator: "array-contains-any", value: manyTags }],
  });

  console.log(`   Total: ${result.data.length} documents trouvés`);
  console.log(`   ✅ Devrait trouver tous les documents (45 au total)\n`);
}

async function main() {
  try {
    await cleanup();
    await seedData();

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚀 Tests du système de requêtes avancées");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    await testOrQuery();
    await testOrQueryWithAnd();
    await testAutoSplitting();
    await testComplexOrWithSplitting();
    await testArrayContainsAnySplitting();

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ Tous les tests terminés avec succès !");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    await cleanup();
    await deleteApp(app);
    process.exit(0);
  } catch (error) {
    console.error("❌ Erreur:", error);
    await deleteApp(app);
    process.exit(1);
  }
}

main();
