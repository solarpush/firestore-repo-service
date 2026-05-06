# firestore-repo-service

[![Documentation](https://img.shields.io/badge/Documentation-Online-blue?style=for-the-badge&logo=read-the-docs)](https://frs.lpdjs.fr)
[![npm version](https://img.shields.io/npm/v/@lpdjs/firestore-repo-service?style=for-the-badge)](https://www.npmjs.com/package/@lpdjs/firestore-repo-service)
[![License](https://img.shields.io/npm/l/@lpdjs/firestore-repo-service?style=for-the-badge)](https://github.com/solarpush/firestore-repo-service/blob/master/LICENSE)

Type-safe Firestore repository layer with auto-generated query methods, CRUD, and a Firestore→SQL sync pipeline via Pub/Sub + BigQuery.

**Full documentation at [frs.lpdjs.fr](https://frs.lpdjs.fr)**

## Installation

```bash
npm install @lpdjs/firestore-repo-service firebase-admin
```

## Quick start

### Define your models

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

### Create the repository mapping

```typescript
import {
  createRepositoryConfig,
  buildRepositoryRelations,
  createRepositoryMapping,
} from "@lpdjs/firestore-repo-service";
import { doc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

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

// Optional: add relations
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  posts: {
    userId: { repo: "users", key: "docId", type: "one" as const },
  },
});

export const repos = createRepositoryMapping(db, mappingWithRelations);
```

### Use the repositories

```typescript
// Fetch a single document
const user = await repos.users.get.byDocId("user123");
const userByEmail = await repos.users.get.byEmail("john@example.com");

// Query multiple documents
const activeUsers = await repos.users.query.byIsActive(true);

// With query options
const results = await repos.users.query.byIsActive(true, {
  where: [["age", ">=", 18]],
  orderBy: [{ field: "name", direction: "asc" }],
  limit: 50,
});

// Populate a relation
const post = await repos.posts.get.byDocId("post123");
if (post) {
  const postWithUser = await repos.posts.populate(post, "userId");
  console.log(postWithUser.populated.users?.name); // type-safe
}

// Update
const updated = await repos.users.update("user123", { name: "New name", age: 31 });
```

## API reference

### `createRepositoryConfig()`

| Option        | Description                                             |
| ------------- | ------------------------------------------------------- |
| `path`        | Collection path in Firestore                            |
| `isGroup`     | `true` for collection group, `false` for simple         |
| `foreignKeys` | Keys for `get.by*` methods (single document lookup)     |
| `queryKeys`   | Keys for `query.by*` methods (multi-document query)     |
| `refCb`       | Function that returns the document reference            |

**Sub-collection example:**

```typescript
comments: createRepositoryConfig<CommentModel>()({
  path: "comments",
  isGroup: true,
  foreignKeys: ["docId"] as const,
  queryKeys: ["postId", "userId"] as const,
  refCb: (db, postId, commentId) =>
    doc(db, "posts", postId, "comments", commentId),
});
```

### Query options

```typescript
interface QueryOptions<T> {
  where?: [keyof T, WhereFilterOp, any][];      // AND conditions
  orWhere?: [keyof T, WhereFilterOp, any][][];  // OR conditions
  orderBy?: { field: keyof T; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  select?: (keyof T)[];
  startAt?: DocumentSnapshot | any[];
  startAfter?: DocumentSnapshot | any[];
  endAt?: DocumentSnapshot | any[];
  endBefore?: DocumentSnapshot | any[];
}
```

### CRUD

```typescript
// Create (auto-generated ID)
const newUser = await repos.users.create({ email: "...", name: "...", age: 25, isActive: true });

// Set (create or replace)
await repos.users.set("user123", { ... });

// Set with merge
await repos.users.set("user123", { age: 31 }, { merge: true });

// Update (partial)
await repos.users.update("user123", { age: 32 });

// Delete
await repos.users.delete("user123");

// Document ref
const ref = repos.users.documentRef("user123");

// Raw collection ref
const colRef = repos.users.ref;
```

### Batch & Bulk

```typescript
// Atomic batch (max 500 operations)
const batch = repos.users.batch.create();
batch.set(repos.users.documentRef("u1"), { ... });
batch.update(repos.users.documentRef("u2"), { age: 25 });
batch.delete(repos.users.documentRef("u3"));
await batch.commit();

// Bulk (auto-split into batches of 500)
await repos.users.bulk.set([
  { docRef: repos.users.documentRef("u1"), data: { ... }, merge: true },
]);
await repos.users.bulk.update([...]);
await repos.users.bulk.delete([...]);
```

### Real-time listeners

```typescript
const unsubscribe = repos.users.query.onSnapshot(
  { where: [["isActive", "==", true]] },
  (users) => console.log(users),
);
unsubscribe();
```

### Pagination

```typescript
const firstPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

const nextPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  startAfter: firstPage[firstPage.length - 1],
  limit: 10,
});

// Paginate with relations
const page = await repos.posts.query.paginate({
  pageSize: 10,
  include: [{ relation: "userId", select: ["docId", "name", "email"] }],
});
```

### Aggregations

```typescript
import { count, sum, average } from "@lpdjs/firestore-repo-service";

const activeCount = await repos.users.aggregate.count({ where: [["isActive", "==", true]] });
const totalViews = await repos.posts.aggregate.sum("views");
const avgAge = await repos.users.aggregate.average("age");
```

### Transactions

```typescript
const result = await repos.users.transaction.run(async (txn) => {
  const user = await txn.get(repos.users.documentRef("user123"));
  if (user.exists()) {
    txn.update(repos.users.documentRef("user123"), { age: user.data().age + 1 });
  }
  return { success: true };
});
```

### OR queries

```typescript
// (status = 'active' AND age >= 18) OR (status = 'pending' AND verified = true)
const users = await repos.users.query.by({
  orWhere: [
    [["status", "==", "active"], ["age", ">=", 18]],
    [["status", "==", "pending"], ["verified", "==", true]],
  ],
});
```

## Servers (admin UI · CRUD REST · Firestore → SQL sync)

A single unified factory binds all servers to your repository registry. Per-repo `repo: …` is no longer needed — the registry key drives both the runtime binding and the inferred model type for `fieldsConfig` autocomplete.

```typescript
import { createServers } from "@lpdjs/firestore-repo-service";
import { onRequest } from "firebase-functions/v2/https";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";

const servers = createServers(repos, {
  onRequest,
  httpsOptions: { invoker: "public" },
});

// Admin UI — repo auto-injected from the key, fieldsConfig typed against the model
export const admin = servers.admin({
  basePath: "/admin",
  auth: { type: "basic", username: "admin", password: "secret" },
  repos: {
    posts: {
      path: "posts",
      fieldsConfig: { title: ["create", "mutable"], status: ["filterable"] },
      allowDelete: true,
    },
    users: { path: "users" },
  },
});

// CRUD REST API
export const api = servers.crud({
  basePath: "/api",
  repos: {
    posts: { path: "posts", allowDelete: true },
    users: { path: "users" },
  },
  openapi: { title: "My API", version: "1.0.0" },
});

// Firestore → BigQuery sync (triggers + worker + admin Cloud Functions)
export const { functions } = servers.sync({
  deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "my-project" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  admin: {
    auth: { type: "basic", username: "admin", password: "secret" },
    featuresFlag: { healthCheck: true, manualSync: true, viewQueue: true, configCheck: true },
  },
  repos: {
    users: { tableName: "users", columnMap: { docId: "user_id" } },
    posts: { columnMap: { docId: "post_id" } },
    comments: { triggerPath: "posts/{postId}/comments/{docId}" },
  },
});

// Spread Cloud Functions into your exports
export const {
  users_onCreate, users_onUpdate, users_onDelete, sync_users,
  posts_onCreate, posts_onUpdate, posts_onDelete, sync_posts,
  comments_onCreate, comments_onUpdate, comments_onDelete, sync_comments,
  adminsync,
} = functions;
```

When `onRequest` is passed to `createServers`, `servers.admin()` and `servers.crud()` return ready-to-export Cloud Functions. Without it, they return raw HTTP handlers you can wrap yourself.

The sync admin endpoint (`/`) exposes a UI for health checks, force-sync, queue inspection, and GCP config verification.

For a custom SQL backend, implement the `SqlAdapter` interface:

```typescript
import type { SqlAdapter } from "@lpdjs/firestore-repo-service/sync";

class MyAdapter implements SqlAdapter {
  // tableExists, getTableColumns, createTable, upsertRows, deleteRows, executeRaw
}
```

Full sync documentation: [frs.lpdjs.fr/guide/sync](https://frs.lpdjs.fr/guide/sync)

## Testing

```bash
# Run emulator + tests (watch mode)
bun run test:watch

# Two-terminal alternative
bun run emulator  # terminal 1
bun run test      # terminal 2
```

Firestore emulator runs on `localhost:8080`, UI on `http://localhost:4000`.

## License

MIT

