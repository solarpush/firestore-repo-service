# Advanced Usage

## CRUD `set()`

Creates or replaces a document with a specific ID.
`documentKey` and `pathKey` are automatically injected (same as `create()`).

```typescript
const post = await repos.posts.set("my-post-id", {
  title: "Hello",
  status: "draft",
  userId: "user_1",
  // docId / documentPath are injected automatically
});
console.log(post.docId);        // "my-post-id"
console.log(post.documentPath); // "posts/my-post-id"

// With merge option
await repos.posts.set("my-post-id", { title: "Updated" }, { merge: true });
```

## Batch Operations

Atomic write up to 500 operations.

```typescript
const batch = repos.posts.batch.create();

batch.set("post-1", { title: "Post 1", userId: "u1", status: "draft" });
batch.set("post-2", { title: "Post 2", userId: "u1", status: "published" });
batch.update("post-3", { status: "published" });
batch.delete("post-old");

await batch.commit();
```

### Sub-collection batch

Pass parent IDs before the document ID:

```typescript
const batch = repos.comments.batch.create();

batch.set(postId, "comment-1", { postId, userId, content: "Hello!", likes: 0 });
batch.set(postId, "comment-2", { postId, userId, content: "World!", likes: 0 });

await batch.commit();
```

## Bulk Operations

Auto-split into batches of 500 for large datasets.

```typescript
const db = getFirestore();

// Bulk set
await repos.users.bulk.set([
  { docRef: db.collection("users").doc("u1"), data: { name: "Alice" }, merge: true },
  { docRef: db.collection("users").doc("u2"), data: { name: "Bob" } },
  // ... thousands of documents
]);

// Bulk update
await repos.users.bulk.update([
  { docRef: db.collection("users").doc("u1"), data: { age: 30 } },
]);

// Bulk delete
await repos.users.bulk.delete([
  db.collection("users").doc("u1"),
  db.collection("users").doc("u2"),
]);
```

## Aggregations

Server-side — no documents transferred.

```typescript
const total   = await repos.users.aggregate.count();
const active  = await repos.users.aggregate.count({ where: [["isActive", "==", true]] });
const ageSum  = await repos.users.aggregate.sum("age");
const ageAvg  = await repos.users.aggregate.average("age", {
  where: [["isActive", "==", true]],
});
```

## Transactions

```typescript
await repos.users.transaction.run(async (tx) => {
  const user = await tx.get("user_1");
  if (!user) throw new Error("not found");
  await tx.update("user_1", { age: user.age + 1 });
});
```

## Real-time listener

```typescript
const unsub = repos.users.query.onSnapshot(
  { where: [["isActive", "==", true]], orderBy: [{ field: "name" }] },
  (users) => console.log("live:", users),
  (err)   => console.error(err),
);

// Later:
unsub();
```

## OR queries — advanced patterns

```typescript
// Simple OR (one clause per entry)
await repos.posts.query.by({
  where:   [["isPublic", "==", true]],       // applied to every OR branch
  orWhere: [
    ["userId",   "==", "user-A"],
    ["authorId", "==", "user-A"],
  ],
});

// Compound OR: (A AND B) OR (C AND D)
await repos.posts.query.by({
  orWhereGroups: [
    [["status", "==", "published"], ["views", ">", 1000]],
    [["status", "==", "featured"],  ["pinned", "==", true]],
  ],
});
```

## `in` operator with >30 values

Automatically split into multiple queries:

```typescript
const ids = Array.from({ length: 90 }, (_, i) => `id-${i}`);

// Generates 3 Firestore queries (30+30+30) merged in memory
const docs = await repos.users.query.by({
  where: [["docId", "in", ids]],
});
```
