# 🔥 Firestore Repository Service

Un service de repository type-safe pour Firestore avec génération automatique des méthodes de requête et CRUD.

## ✨ Fonctionnalités

- 🎯 **Type-safe** : TypeScript avec inférence complète des types
- 🚀 **Auto-génération** : Méthodes `get.by*` et `query.by*` générées automatiquement
- 🔍 **Requêtes avancées** : Support des conditions OR, tri, pagination avec curseurs
- 📦 **Opérations en masse** : Batch et bulk operations
- 🏗️ **Collections et sous-collections** : Support complet
- 💡 **API intuitive** : Accesseurs directs via getters
- 📡 **Real-time** : Listeners `onSnapshot` pour les mises à jour en temps réel
- 🔢 **Agrégations** : Count, sum, average avec support serveur
- ✏️ **CRUD complet** : Create, set, update, delete avec types préservés
- 🔄 **Transactions** : Opérations transactionnelles type-safe

## 📦 Installation

```bash
npm install @lpdjs/firestore-repo-service firebase
# ou
yarn add @lpdjs/firestore-repo-service firebase
# ou
bun add @lpdjs/firestore-repo-service firebase
```

## 🚀 Démarrage rapide

### 1. Définir vos modèles

```typescript
interface UserModel {
  docId: string;
  email: string;
  name: string;
  age: number;
  isActive: boolean;
}

interface PostModel {
  docId: string;
  userId: string;
  title: string;
  status: "draft" | "published";
}
```

### 2. Créer votre mapping

```typescript
import {
  createRepositoryConfig,
  buildRepositoryRelations,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { doc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

// 1. Définir la configuration de base
const repositoryMapping = {
  users: createRepositoryConfig<UserModel>()({
    path: "users",
    isGroup: false,
    foreignKeys: ["docId", "email"] as const,
    queryKeys: ["name", "isActive"] as const,
    refCb: (db: Firestore, docId: string) => doc(db, "users", docId),
  }),

  posts: createRepositoryConfig<PostModel>()({
    path: "posts",
    isGroup: false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys: ["status"] as const,
    refCb: (db: Firestore, docId: string) => doc(db, "posts", docId),
  }),
};

// 2. Ajouter les relations (Optionnel)
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  posts: {
    userId: { repo: "users", key: "docId", type: "one" as const },
  },
});

// 3. Créer le service
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

### 3. Utiliser les repositories

```typescript
// Récupérer un document unique
const user = await repos.users.get.byDocId("user123");
const userByEmail = await repos.users.get.byEmail("john@example.com");

// Rechercher des documents
const activeUsers = await repos.users.query.byIsActive(true);

// Relations (Populate)
const post = await repos.posts.get.byDocId("post123");
if (post) {
  const postWithUser = await repos.posts.populate(post, "userId");
  console.log(postWithUser.populated.users?.name); // Type-safe!
}

// Recherche avec options
const filteredUsers = await repos.users.query.byName("John", {
  where: [{ field: "age", operator: ">=", value: 18 }],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// Mettre à jour un document
const updated = await repos.users.update("user123", {
  name: "John Updated",
  age: 31,
});
```

## 📚 Guide complet

### Configuration

#### `createRepositoryConfig()`

Configure un repository avec ses clés et méthodes.

**Paramètres :**

- `path` : Chemin de la collection dans Firestore
- `isGroup` : `true` pour une collection group, `false` pour une collection simple
- `foreignKeys` : Clés pour les méthodes `get.by*` (recherche unique)
- `queryKeys` : Clés pour les méthodes `query.by*` (recherche multiple)
- `type` : Type TypeScript du modèle
- `refCb` : Fonction pour créer la référence du document

**Exemple collection simple :**

```typescript
users: createRepositoryConfig<UserModel>()({
  path: "users",
  isGroup: false,
  foreignKeys: ["docId", "email"] as const,
  queryKeys: ["isActive", "role"] as const,
  refCb: (db: Firestore, docId: string) => doc(db, "users", docId),
});
```

**Exemple sous-collection :**

```typescript
comments: createRepositoryConfig<CommentModel>()({
  path: "comments",
  isGroup: true,
  foreignKeys: ["docId"] as const,
  queryKeys: ["postId", "userId"] as const,
  refCb: (db: Firestore, postId: string, commentId: string) =>
    doc(db, "posts", postId, "comments", commentId),
});
```

### Méthodes GET

Récupère un **document unique** par une clé étrangère.

```typescript
// Méthodes générées automatiquement depuis foreignKeys
const user = await repos.users.get.byDocId("user123");
const userByEmail = await repos.users.get.byEmail("john@example.com");

// Avec le DocumentSnapshot
const result = await repos.users.get.byDocId("user123", true);
if (result) {
  console.log(result.data); // UserModel
  console.log(result.doc); // DocumentSnapshot
}

// Récupérer par liste de valeurs
const users = await repos.users.get.byList("docId", [
  "user1",
  "user2",
  "user3",
]);
```

### Méthodes QUERY

Recherche **plusieurs documents** par une clé de requête.

```typescript
// Méthodes générées automatiquement depuis queryKeys
const activeUsers = await repos.users.query.byIsActive(true);
const usersByName = await repos.users.query.byName("John");

// Avec options
const results = await repos.users.query.byIsActive(true, {
  where: [{ field: "age", operator: ">=", value: 18 }],
  orderBy: [{ field: "name", direction: "asc" }],
  limit: 50,
});

// Requête générique
const users = await repos.users.query.by({
  where: [
    { field: "isActive", operator: "==", value: true },
    { field: "age", operator: ">=", value: 18 },
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// Conditions OR
const posts = await repos.posts.query.by({
  orWhere: [
    [{ field: "status", operator: "==", value: "published" }],
    [{ field: "status", operator: "==", value: "draft" }],
  ],
});
```

### Options de requête

```typescript
interface QueryOptions<T> {
  where?: WhereClause<T>[]; // Conditions AND
  orWhere?: WhereClause<T>[][]; // Conditions OR
  orderBy?: {
    field: keyof T;
    direction?: "asc" | "desc";
  }[];
  limit?: number; // Nombre max de résultats
  offset?: number; // Pagination (skip)
  startAt?: DocumentSnapshot | any[]; // Cursor pagination - start at
  startAfter?: DocumentSnapshot | any[]; // Cursor pagination - start after
  endAt?: DocumentSnapshot | any[]; // Cursor pagination - end at
  endBefore?: DocumentSnapshot | any[]; // Cursor pagination - end before
}
```

### Mise à jour

```typescript
// Met à jour et retourne le document mis à jour
const updated = await repos.users.update("user123", {
  name: "New Name",
  age: 30,
});

// Pour sous-collections
const updatedComment = await repos.comments.update(
  "post123", // postId
  "comment456", // commentId
  { text: "Updated text" }
);
```

### Références de documents

```typescript
const userRef = repos.users.documentRef("user123");
const commentRef = repos.comments.documentRef("post123", "comment456");
```

### Opérations Batch

Pour des opérations atomiques (max 500 opérations).

```typescript
const batch = repos.users.batch.create();

batch.set(repos.users.documentRef("user1"), {
  name: "User One",
  email: "user1@example.com",
});

batch.update(repos.users.documentRef("user2"), {
  age: 25,
});

batch.delete(repos.users.documentRef("user3"));

await batch.commit();
```

### Opérations Bulk

Pour traiter de grandes quantités (automatiquement divisées en batches de 500).

```typescript
// Set multiple
await repos.users.bulk.set([
  {
    docRef: repos.users.documentRef("user1"),
    data: { name: "User 1", email: "user1@example.com" },
    merge: true,
  },
  {
    docRef: repos.users.documentRef("user2"),
    data: { name: "User 2", email: "user2@example.com" },
  },
  // ... jusqu'à des milliers de documents
]);

// Update multiple
await repos.users.bulk.update([
  { docRef: repos.users.documentRef("user1"), data: { age: 30 } },
  { docRef: repos.users.documentRef("user2"), data: { age: 25 } },
]);

// Delete multiple
await repos.users.bulk.delete([
  repos.users.documentRef("user1"),
  repos.users.documentRef("user2"),
]);
```

### Récupérer tous les documents

```typescript
// Récupère tous les documents de la collection
const allUsers = await repos.users.query.getAll();

// Avec des options de filtrage et tri
const filteredUsers = await repos.users.query.getAll({
  where: [{ field: "isActive", operator: "==", value: true }],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 100,
});
```

### Real-time listeners (onSnapshot)

```typescript
// Écouter les changements en temps réel
const unsubscribe = repos.users.query.onSnapshot(
  {
    where: [{ field: "isActive", operator: "==", value: true }],
    orderBy: [{ field: "name", direction: "asc" }],
  },
  (users) => {
    console.log("Données mises à jour:", users);
  },
  (error) => {
    console.error("Erreur:", error);
  }
);

// Arrêter l'écoute
unsubscribe();
```

### Pagination avec curseurs

La pagination basée sur les curseurs est plus efficace que `offset` pour de grandes collections.

```typescript
// Première page
const firstPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// Page suivante en utilisant le dernier document
const lastDoc = firstPage[firstPage.length - 1];
const nextPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  startAfter: lastDoc, // ou utiliser un tableau de valeurs
  limit: 10,
});

// Exemple avec des valeurs
const page = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  startAfter: [new Date("2024-01-01")],
  limit: 10,
});
```

### CRUD complet

```typescript
// Create - Créer avec ID auto-généré
const newUser = await repos.users.create({
  email: "new@example.com",
  name: "New User",
  age: 25,
  isActive: true,
});
console.log(newUser.docId); // ID auto-généré

// Set - Créer ou remplacer complètement
await repos.users.set("user123", {
  email: "user@example.com",
  name: "User",
  age: 30,
  isActive: true,
});

// Set avec merge - Fusion partielle
await repos.users.set(
  "user123",
  { age: 31 }, // Seul 'age' sera modifié
  { merge: true }
);

// Update - Mise à jour partielle
const updated = await repos.users.update("user123", {
  age: 32,
  name: "Updated Name",
});

// Delete - Supprimer un document
await repos.users.delete("user123");
```

### Transactions

```typescript
// Transaction avec méthodes type-safe
const result = await repos.users.transaction.run(async (txn) => {
  // Get document dans la transaction
  const user = await txn.get(repos.users.documentRef("user123"));

  if (user.exists()) {
    const userData = user.data();

    // Update dans la transaction
    txn.update(repos.users.documentRef("user123"), {
      age: userData.age + 1,
    });

    // Set dans la transaction
    txn.set(repos.users.documentRef("user124"), {
      email: "new@example.com",
      name: "New User",
    });

    // Delete dans la transaction
    txn.delete(repos.users.documentRef("user125"));
  }

  return { success: true };
});

// Accès à la transaction Firestore brute si nécessaire
await repos.users.transaction.run(async (txn) => {
  const rawTransaction = txn.raw;
  // Utiliser rawTransaction avec l'API Firestore native
});
```

### Agrégations

```typescript
import { count, sum, average } from "@lpdjs/firestore-repo-service";

// Compter les documents
const activeCount = await repos.users.aggregate.count({
  where: [{ field: "isActive", operator: "==", value: true }],
});

// Agrégations personnalisées (count, sum, average)
const stats = await repos.users.aggregate.query(
  {
    totalUsers: count(),
    totalAge: sum("age"),
    averageAge: average("age"),
  },
  {
    where: [{ field: "isActive", operator: "==", value: true }],
  }
);

console.log(stats.totalUsers); // nombre total
console.log(stats.totalAge); // somme des âges
console.log(stats.averageAge); // moyenne des âges
```

### Accès à la collection Firestore

```typescript
// Référence brute si besoin
const collectionRef = repos.users.ref;
```

## 🎯 Exemples avancés

### Collection imbriquée complexe

```typescript
const repositoryMapping = {
  eventRatings: createRepositoryConfig<RatingModel>()({
    path: "ratings",
    isGroup: true,
    foreignKeys: ["docId"] as const,
    queryKeys: ["eventId", "rating"] as const,
    refCb: (
      db: Firestore,
      residenceId: string,
      eventId: string,
      ratingId: string
    ) =>
      doc(
        db,
        "residences",
        residenceId,
        "events",
        eventId,
        "ratings",
        ratingId
      ),
  }),
};

// Utilisation
const rating = await repos.eventRatings.update(
  "residence123",
  "event456",
  "rating789",
  { score: 5 }
);
```

### Recherche complexe avec OR

```typescript
// (status = 'active' AND age >= 18) OR (status = 'pending' AND verified = true)
const users = await repos.users.query.by({
  orWhere: [
    [
      { field: "status", operator: "==", value: "active" },
      { field: "age", operator: ">=", value: 18 },
    ],
    [
      { field: "status", operator: "==", value: "pending" },
      { field: "verified", operator: "==", value: true },
    ],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 100,
});
```

## 🔧 Types exportés

```typescript
// Types utiles
import type {
  WhereClause,
  QueryOptions,
  RepositoryKey,
  RepositoryModelType,
} from "@lpdjs/firestore-repo-service";
```

## 🧪 Tests avec l'émulateur

Pour tester rapidement sans projet Firebase :

```bash
# 1. Installer Firebase CLI (si nécessaire)
npm install -g firebase-tools

# 2. Démarrer l'émulateur (terminal 1)
bun run emulator

# 3. Lancer les tests (terminal 2)
bun run test:emulator
```

L'émulateur Firestore démarre sur `localhost:8080` avec une UI sur `http://localhost:4000`.

Voir `test/README.md` pour plus de détails.

## 📝 Licence

MIT

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

## 📬 Support

Pour toute question ou problème, ouvrez une issue sur GitHub.
