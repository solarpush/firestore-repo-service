# Getting Started

## Installation

```bash
npm install @lpdjs/firestore-repo-service firebase-admin
# or
bun add @lpdjs/firestore-repo-service firebase-admin
```

## Quick Start

### 1. Define your models with Zod (recommended)

Using Zod gives you automatic schema inference — no need to declare the model interface separately.

```typescript
import z from "zod";

const userSchema = z.object({
  docId:          z.string(),
  documentPath:   z.string(),
  email:          z.string(),
  name:           z.string().nullable(),
  age:            z.number(),
  isActive:       z.boolean().nullable(),
  createdAt:      z.date(),
  updatedAt:      z.date(),
});

const postSchema = z.object({
  docId:         z.string(),
  documentPath:  z.string(),
  userId:        z.string(),
  title:         z.string(),
  content:       z.string(),
  status:        z.enum(["draft", "published"]),
  createdAt:     z.date(),
  updatedAt:     z.date(),
});
```

::: tip Without Zod
Pass the TypeScript interface as generic and omit the schema argument:
```typescript
const users = createRepositoryConfig<UserModel>()({ /* config */ });
```
:::

### 2. Create your repository mapping

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

// Step 1 — base config
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

// Step 2 — relations (optional)
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  users: { docId:  { repo: "posts",  key: "userId", type: "many" as const } },
  posts: { userId: { repo: "users",  key: "docId",  type: "one"  as const } },
});

// Step 3 — create the service
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

### 3. Use the repositories

```typescript
// Create
const user = await repos.users.create({
  name: "Alice", email: "alice@example.com", age: 28, isActive: true,
});
console.log(user.docId);        // auto-injected
console.log(user.documentPath); // auto-injected

// Read
const found   = await repos.users.get.byDocId(user.docId);
const byEmail = await repos.users.get.byEmail("alice@example.com");

// Query
const active = await repos.users.query.byIsActive(true);

// Update
await repos.users.update(user.docId, { age: 29 });

// Delete
await repos.users.delete(user.docId);

// Paginate
const page = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy:  [{ field: "createdAt", direction: "desc" }],
});
console.log(page.data, page.hasNextPage);

// Populate a relation
const post = await repos.posts.get.byDocId("post_1");
const withAuthor = await repos.posts.populate(post!, "userId");
console.log(withAuthor.populated.userId); // UserModel | null
```
