# Démarrage rapide

## Installation

```bash
npm install @lpdjs/firestore-repo-service firebase-admin
# ou
bun add @lpdjs/firestore-repo-service firebase-admin
```

## Démarrage en 3 étapes

### 1. Définir les modèles avec Zod (recommandé)

Zod permet l'inférence automatique du type — pas besoin de déclarer l'interface séparément.

```typescript
import z from "zod";

const userSchema = z.object({
  docId:        z.string(),
  documentPath: z.string(),
  email:        z.string(),
  name:         z.string().nullable(),
  age:          z.number(),
  isActive:     z.boolean().nullable(),
  createdAt:    z.date(),
  updatedAt:    z.date(),
});

const postSchema = z.object({
  docId:        z.string(),
  documentPath: z.string(),
  userId:       z.string(),
  title:        z.string(),
  content:      z.string(),
  status:       z.enum(["draft", "published"]),
  createdAt:    z.date(),
  updatedAt:    z.date(),
});
```

::: tip Sans Zod
Passer l'interface TypeScript en générique :
```typescript
const users = createRepositoryConfig<UserModel>()({ /* config */ });
```
:::

### 2. Créer le mapping de repositories

```typescript
import {
  createRepositoryConfig,
  buildRepositoryRelations,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { initializeApp }           from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const repositoryMapping = {
  users: createRepositoryConfig(userSchema)({
    path:        "users",
    isGroup:     false,
    foreignKeys: ["docId", "email"] as const,
    queryKeys:   ["name", "isActive"] as const,
    documentKey: "docId",
    pathKey:     "documentPath",
    createdKey:  "createdAt",
    updatedKey:  "updatedAt",
    refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
  }),

  posts: createRepositoryConfig(postSchema)({
    path:        "posts",
    isGroup:     false,
    foreignKeys: ["docId", "userId"] as const,
    queryKeys:   ["status", "userId"] as const,
    documentKey: "docId",
    pathKey:     "documentPath",
    createdKey:  "createdAt",
    updatedKey:  "updatedAt",
    refCb: (db: Firestore, docId: string) => db.collection("posts").doc(docId),
  }),
};

const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  users: { docId:  { repo: "posts", key: "userId", type: "many" as const } },
  posts: { userId: { repo: "users", key: "docId",  type: "one"  as const } },
});

export const repos = createRepositoryMapping(db, mappingWithRelations);
```

### 3. Utiliser les repositories

```typescript
// Créer
const user = await repos.users.create({
  name: "Alice", email: "alice@example.com", age: 28, isActive: true,
});
console.log(user.docId);        // injecté automatiquement
console.log(user.documentPath); // injecté automatiquement

// Lire
const found   = await repos.users.get.byDocId(user.docId);
const byEmail = await repos.users.get.byEmail("alice@example.com");

// Requêter
const active = await repos.users.query.byIsActive(true);

// Mettre à jour
await repos.users.update(user.docId, { age: 29 });

// Supprimer
await repos.users.delete(user.docId);

// Paginer
const page = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy:  [{ field: "createdAt", direction: "desc" }],
});
console.log(page.data, page.hasNextPage);

// Peupler une relation
const post = await repos.posts.get.byDocId("post_1");
const withAuthor = await repos.posts.populate(post!, "userId");
console.log(withAuthor.populated.userId); // UserModel | null
```
