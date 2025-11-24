# Configuration

## `createRepositoryConfig()`

Configures a repository with its keys and methods.

**Parameters:**

- `path`: Collection path in Firestore
- `isGroup`: `true` for collection group queries, `false` for simple collections
- `foreignKeys`: Keys for `get.by*` methods (unique retrieval)
- `queryKeys`: Keys for `query.by*` methods (multiple retrieval)
- `type`: TypeScript type of the model
- `refCb`: Function to create the document reference

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
