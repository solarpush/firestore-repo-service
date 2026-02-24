# Configuration

## `createRepositoryConfig()`

| Parameter     | Type       | Default           | Description                                       |
|---------------|------------|-------------------|---------------------------------------------------|
| `path`        | `string`   | —                 | Firestore collection path                         |
| `isGroup`     | `boolean`  | —                 | `true` for collection group queries               |
| `foreignKeys` | `string[]` | —                 | Keys for `get.by*` (unique retrieval)              |
| `queryKeys`   | `string[]` | —                 | Keys for `query.by*` (list retrieval)              |
| `refCb`       | Function   | —                 | Builds the `DocumentReference`                    |
| `documentKey` | `string`   | `"docId"`         | Field auto-injected with the Firestore document ID |
| `pathKey`     | `string`   | `"documentPath"`  | Field auto-injected with the full Firestore path  |
| `createdKey`  | `string`   | `"createdAt"`     | Field auto-set on creation                        |
| `updatedKey`  | `string`   | `"updatedAt"`     | Field auto-updated on every write                 |

### Simple collection

```typescript
users: createRepositoryConfig(userSchema)({
  path:        "users",
  isGroup:     false,
  foreignKeys: ["docId", "email"] as const,
  queryKeys:   ["isActive", "name"] as const,
  documentKey: "docId",
  pathKey:     "documentPath",
  createdKey:  "createdAt",
  updatedKey:  "updatedAt",
  refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
});
```

### Sub-collection

The `refCb` receives parent IDs in order, then the document ID last.

```typescript
comments: createRepositoryConfig<CommentModel>()({
  path:        "comments",
  isGroup:     true,
  foreignKeys: ["docId", "postId", "userId"] as const,
  queryKeys:   ["postId", "userId"] as const,
  documentKey: "docId",
  pathKey:     "documentPath",
  createdKey:  "createdAt",
  updatedKey:  "updatedAt",
  refCb: (db: Firestore, postId: string, commentId: string) =>
    db.collection("posts").doc(postId).collection("comments").doc(commentId),
});
```

## `buildRepositoryRelations()`

Declares relationships between repositories.

```typescript
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  users: {
    docId:  { repo: "posts",    key: "userId", type: "many" as const },
  },
  posts: {
    userId: { repo: "users",    key: "docId",  type: "one"  as const },
    docId:  { repo: "comments", key: "postId", type: "many" as const },
  },
  comments: {
    postId: { repo: "posts",    key: "docId",  type: "one"  as const },
    userId: { repo: "users",    key: "docId",  type: "one"  as const },
  },
});
```

::: tip Validation
TypeScript validates that repository names, foreign keys, and relation keys all exist in your mapping.
:::

## `createRepositoryMapping()`

```typescript
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

## Generated methods overview

| Namespace       | Method                                   | Description                                |
|-----------------|------------------------------------------|--------------------------------------------|
| (root)          | `create(data)`                           | Create with auto ID                        |
| (root)          | `set(id, data, options?)`                | Create / replace with specific ID         |
| (root)          | `update(id, data)`                       | Partial update                             |
| (root)          | `delete(id)`                             | Delete document                            |
| `get`           | `by{ForeignKey}(value)`                  | Get single document                        |
| `get`           | `byList(key, values[])`                  | Get multiple documents by value list       |
| `query`         | `by{QueryKey}(value, options?)`          | Query by key                               |
| `query`         | `by(options)`                            | Generic query (full options)               |
| `query`         | `getAll(options?)`                       | Get all documents                          |
| `query`         | `paginate(options)`                      | Cursor-based pagination                    |
| `query`         | `paginateAll(options)`                   | Async generator over all pages             |
| `query`         | `onSnapshot(options, cb, errCb?)`        | Real-time listener                         |
| `batch`         | `create()`                               | Create a batch builder (max 500 ops)       |
| `bulk`          | `set / update / delete`                  | Bulk operations (auto-split)               |
| `populate`      | `(doc, key \| options)`                  | Populate related documents                 |
| `aggregate`     | `count / sum / average`                  | Server-side aggregations                   |
| `transaction`   | `run(callback)`                          | Firestore transaction                      |
