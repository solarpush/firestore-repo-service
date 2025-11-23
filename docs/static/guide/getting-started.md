# Getting Started

## Installation

```bash
npm install @lpdjs/firestore-repo-service firebase
# or
yarn add @lpdjs/firestore-repo-service firebase
# or
bun add @lpdjs/firestore-repo-service firebase
```

## Quick Start

### 1. Define your models

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

### 2. Create your mapping

```typescript
import {
  createRepositoryConfig,
  buildRepositoryRelations,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { doc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

// 1. Define base configuration
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

// 2. Add relations (Optional)
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  posts: {
    userId: { repo: "users", key: "docId", type: "one" as const },
  },
});

// 3. Create the service
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

### 3. Use the repositories

```typescript
// Get a single document
const user = await repos.users.get.byDocId("user123");
const userByEmail = await repos.users.get.byEmail("john@example.com");

// Query documents
const activeUsers = await repos.users.query.byIsActive(true);

// Relations (Populate)
const post = await repos.posts.get.byDocId("post123");
if (post) {
  const postWithUser = await repos.posts.populate(post, "userId");
  console.log(postWithUser.populated.users?.name); // Type-safe!
}

// Query with options
const filteredUsers = await repos.users.query.byName("John", {
  where: [{ field: "age", operator: ">=", value: 18 }],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// Update a document
const updated = await repos.users.update("user123", {
  name: "John Updated",
  age: 31,
});
```
