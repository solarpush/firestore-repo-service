/**
 * Exemple d'utilisation du package firestore-repo-service
 */

import type { Firestore } from "firebase/firestore";
import { doc } from "firebase/firestore";
import { createRepositoryConfig, createRepositoryMapping } from "./index";

// 1. Définir vos modèles TypeScript
interface UserModel {
  docId: string;
  email: string;
  name: string;
  age: number;
  createdAt: Date;
  isActive: boolean;
}

interface PostModel {
  docId: string;
  userId: string;
  title: string;
  content: string;
  tags: string[];
  publishedAt: Date;
  status: "draft" | "published" | "archived";
}

interface CommentModel {
  docId: string;
  postId: string;
  userId: string;
  text: string;
  createdAt: Date;
}

// 2. Créer votre configuration de repositories
const myRepositoryMapping = {
  // Collection simple (racine)
  users: createRepositoryConfig({
    path: "users",
    isGroup: false,
    foreignKeys: ["docId", "email"] as const,
    queryKeys: ["name", "isActive"] as const,
    type: {} as UserModel,
    refCb: (db: Firestore, docId: string) => {
      return doc(db, "users", docId);
    },
  }),

  // Collection simple avec plus de clés de recherche
  posts: createRepositoryConfig({
    path: "posts",
    isGroup: false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys: ["status", "publishedAt"] as const,
    type: {} as PostModel,
    refCb: (db: Firestore, docId: string) => {
      return doc(db, "posts", docId);
    },
  }),

  // Sous-collection (collection group)
  comments: createRepositoryConfig({
    path: "comments",
    isGroup: true,
    foreignKeys: ["docId"] as const,
    queryKeys: ["postId", "userId"] as const,
    type: {} as CommentModel,
    refCb: (db: Firestore, postId: string, commentId: string) => {
      return doc(db, "posts", postId, "comments", commentId);
    },
  }),
} as const;

// 3. Créer l'instance du mapping avec getters automatiques
const repos = createRepositoryMapping(myRepositoryMapping);

// 4. Utiliser les repositories
async function exemples() {
  // Accès direct aux repositories via les getters
  const users = repos.users;
  const posts = repos.posts;
  const comments = repos.comments;

  // === GET: Récupérer un document unique ===

  // Par docId
  const user = await users.get.byDocId("user123");
  console.log(user); // UserModel | null

  // Par email
  const userByEmail = await users.get.byEmail("john@example.com");
  console.log(userByEmail); // UserModel | null

  // Avec le document Firestore
  const userWithDoc = await users.get.byDocId("user123", true);
  if (userWithDoc) {
    console.log(userWithDoc.data); // UserModel
    console.log(userWithDoc.doc); // DocumentSnapshot
  }

  // Par une liste de valeurs
  const usersByIds = await users.get.byList("docId", [
    "user1",
    "user2",
    "user3",
  ]);
  console.log(usersByIds); // UserModel[]

  // === QUERY: Rechercher des documents ===

  // Recherche simple par un queryKey
  const activeUsers = await users.query.byIsActive(true);
  console.log(activeUsers); // UserModel[]

  // Recherche avec options
  const usersByName = await users.query.byName("John", {
    where: [{ field: "age", operator: ">=", value: 18 }],
    orderBy: [{ field: "createdAt", direction: "desc" }],
    limit: 10,
  });

  // Recherche générique avec query.by
  const filteredUsers = await users.query.by({
    where: [
      { field: "isActive", operator: "==", value: true },
      { field: "age", operator: ">=", value: 18 },
    ],
    orderBy: [{ field: "name", direction: "asc" }],
    limit: 50,
  });

  // Recherche avec conditions OR
  const publishedOrDraftPosts = await posts.query.by({
    orWhere: [
      [{ field: "status", operator: "==", value: "published" }],
      [{ field: "status", operator: "==", value: "draft" }],
    ],
  });

  // === UPDATE: Mettre à jour un document ===

  // Mettre à jour et récupérer le document mis à jour
  const updatedUser = await users.update("user123", {
    name: "John Updated",
    age: 31,
  });
  console.log(updatedUser); // UserModel avec les nouvelles valeurs

  // Pour les sous-collections
  const updatedComment = await comments.update("post123", "comment456", {
    text: "Updated comment text",
  });

  // === DOCUMENT REF: Obtenir une référence ===

  const userRef = users.documentRef("user123");
  const postRef = posts.documentRef("post456");
  const commentRef = comments.documentRef("post123", "comment789");

  // === BATCH: Opérations atomiques ===

  const batch = users.batch.create();

  batch.set(users.documentRef("user1"), {
    name: "User One",
    email: "user1@example.com",
  });

  batch.update(users.documentRef("user2"), {
    age: 25,
  });

  batch.delete(users.documentRef("user3"));

  await batch.commit();

  // === BULK: Opérations en masse ===

  // Créer/mettre à jour plusieurs documents
  await users.bulk.set([
    {
      docRef: users.documentRef("user1"),
      data: { name: "User 1", email: "user1@example.com" },
      merge: true,
    },
    {
      docRef: users.documentRef("user2"),
      data: { name: "User 2", email: "user2@example.com" },
      merge: true,
    },
  ]);

  // Mettre à jour plusieurs documents
  await users.bulk.update([
    { docRef: users.documentRef("user1"), data: { age: 30 } },
    { docRef: users.documentRef("user2"), data: { age: 25 } },
  ]);

  // Supprimer plusieurs documents
  await users.bulk.delete([
    users.documentRef("user1"),
    users.documentRef("user2"),
  ]);

  // === ACCÈS À LA COLLECTION REF ===

  // Référence Firestore brute si besoin
  const usersCollectionRef = users.ref;
}

// Export pour utilisation dans d'autres fichiers
export { myRepositoryMapping, repos };
