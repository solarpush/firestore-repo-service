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

// db is resolved lazily on first access — never at import time.
export const repos = createRepositoryMapping(() => getFirestore(), mappingWithRelations);
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
| `system`        | `backfillKeys(options?)`                 | Backfill auto-managed system fields        |
| `populate`      | `(doc, key \| options)`                  | Populate related documents                 |
| `aggregate`     | `count / sum / average`                  | Server-side aggregations                   |
| `transaction`   | `run(callback)`                          | Firestore transaction                      |

## System fields & `system.backfillKeys()`

The optional `documentKey`, `pathKey`, `createdKey` and `updatedKey` config keys
are **auto-managed**: the package writes them on every `create` / `set` /
`update` / `batch` / `bulk` operation. Documents written **outside** the package
(legacy data, manual imports) may lack them — which has consequences:

- **Missing `pathKey`** — the CRUD / admin server reconstructs a document's path
  from this field to `update` / `delete` it. Without it, **sub-collection /
  collectionGroup documents can no longer be updated or deleted through the
  server layer** (top-level collections still work).
- **Missing `createdKey` / `updatedKey`** — any `query.getAll({ orderBy: [[...]] })`
  on that field **silently drops** documents that don't have it (Firestore
  omits documents missing an `orderBy` field).
- **Missing `documentKey`** — direct reads (`get.by{DocumentKey}`) still work
  (they use the document reference), but the BigQuery sync primary key may be null.

`system.backfillKeys()` repairs legacy documents. It streams the whole
collection (paginated) and fills only the documents that need it:

- `pathKey` ← the document's live `ref.path` (the **full** nested path, so
  sub-collection / collectionGroup docs become server-updatable again),
- `documentKey` ← `doc.id` when missing,
- `createdKey` ← `now()` **only when missing** (existing timestamps preserved),
- `updatedKey` ← `now()` **only when missing**.

It is idempotent and write-minimal (documents already complete are skipped), so
it is safe to run repeatedly.

```typescript
// Migrate legacy documents in place.
const { scanned, written, skipped, failures } =
  await repos.residences.system.backfillKeys();

// Preview without writing.
const preview = await repos.residences.system.backfillKeys({ dryRun: true });

// Observe partial failures instead of throwing.
await repos.residences.system.backfillKeys({
  pageSize: 500,
  onError: ({ path, error }) => console.error(path, error.message),
  onSuccess: (path) => metrics.inc("backfilled"),
});
```

| Option             | Default | Description                                              |
|--------------------|---------|----------------------------------------------------------|
| `overwriteCreated` | `false` | Rewrite `createdKey` even when already present           |
| `touchUpdated`     | `true`  | Fill `updatedKey` with now when missing                  |
| `overwritePath`    | `false` | Always rewrite `pathKey` from the live ref path          |
| `pageSize`         | `300`   | Documents fetched per page                                |
| `dryRun`           | `false` | Count what would change without writing                  |
| `maxAttempts`      | `5`     | Retry attempts per document for retryable errors         |
| `onError`          | —       | Called once per permanently failed document              |
| `onSuccess`        | —       | Called once per successfully patched document            |

Returns `{ scanned, written, skipped, failures }`.
