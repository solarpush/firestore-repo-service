# Configuration

## `createRepositoryConfig()`

Configures a repository with its keys and methods.

**Parameters:**

| Parameter     | Type                | Description                                                         |
| ------------- | ------------------- | ------------------------------------------------------------------- |
| `path`        | `string`            | Collection path in Firestore                                        |
| `isGroup`     | `boolean`           | `true` for collection group queries, `false` for simple collections |
| `foreignKeys` | `readonly string[]` | Keys for `get.by*` methods (unique retrieval)                       |
| `queryKeys`   | `readonly string[]` | Keys for `query.by*` methods (multiple retrieval)                   |
| `refCb`       | `Function`          | Function to create the document reference                           |
| `documentKey` | `string`            | Field name for document ID (default: `"docId"`)                     |
| `pathKey`     | `string`            | Field name for document path (default: `"documentPath"`)            |
| `createdKey`  | `string`            | Field name for creation timestamp (default: `"createdAt"`)          |
| `updatedKey`  | `string`            | Field name for update timestamp (default: `"updatedAt"`)            |

### Simple Collection Example

```typescript
users: createRepositoryConfig<UserModel>()({
  path: "users",
  isGroup: false,
  foreignKeys: ["docId", "email"] as const,
  queryKeys: ["isActive", "role"] as const,
  refCb: (db: Firestore, docId: string) => doc(db, "users", docId),
});
```

### Sub-collection Example

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

### Custom Keys Example

```typescript
// Using custom field names for document ID and timestamps
users: createRepositoryConfig<UserModel>()({
  path: "users",
  isGroup: false,
  foreignKeys: ["id", "email"] as const,
  queryKeys: ["isActive"] as const,
  refCb: (db: Firestore, id: string) => doc(db, "users", id),
  documentKey: "id", // Instead of "docId"
  pathKey: "path", // Instead of "documentPath"
  createdKey: "createdDate", // Instead of "createdAt"
  updatedKey: "modifiedDate", // Instead of "updatedAt"
});
```

## `buildRepositoryRelations()`

Defines relationships between repositories. This enables the `populate` method.

```typescript
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  posts: {
    // Foreign key in PostModel -> target repository and key
    userId: {
      repo: "users", // Target repository name
      key: "docId", // Target foreign key
      type: "one", // Relation type: "one" or "many"
    },
    categoryId: {
      repo: "categories",
      key: "docId",
      type: "one",
    },
  },
  users: {
    // One-to-many: a user has many posts
    docId: {
      repo: "posts",
      key: "userId",
      type: "many",
    },
  },
});
```

::: tip Type Safety
The `buildRepositoryRelations` function validates that:

1. The repository names exist in your mapping
2. The foreign keys exist in the target repository configuration
3. The relation keys exist in your source model
   :::

## `createRepositoryMapping()`

Creates the final repository service with all methods.

```typescript
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

## Generated Methods

Each repository gets the following methods:

### CRUD Operations

- `create(data)` - Create with auto-generated ID
- `set(id, data, options?)` - Create/replace with specific ID
- `update(id, data)` - Partial update
- `delete(id)` - Delete document

### Get Methods (from `foreignKeys`)

- `get.by{Key}(value)` - Get single document by key
- `get.byList(key, values)` - Get multiple documents by list of values

### Query Methods (from `queryKeys`)

- `query.by{Key}(value, options?)` - Query by key
- `query.by(options)` - Generic query
- `query.getAll(options?)` - Get all documents
- `query.paginate(options)` - Paginated query with cursor support
- `query.onSnapshot(options, callback, errorCallback?)` - Real-time listener

### Batch Operations

- `batch.create()` - Create a batch builder

### Bulk Operations

- `bulk.set(items)` - Bulk set (auto-batched)
- `bulk.update(items)` - Bulk update
- `bulk.delete(refs)` - Bulk delete

### Relations

- `populate(doc, relationKey | options)` - Populate related documents

### Aggregations

- `aggregate.count(options?)` - Count documents
- `aggregate.sum(field, options?)` - Sum field values
- `aggregate.average(field, options?)` - Average field values

### Transactions

- `transaction.run(callback)` - Run operations in a transaction
