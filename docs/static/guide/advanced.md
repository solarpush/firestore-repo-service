# Advanced Usage

## Batch Operations

For atomic operations (max 500 operations).

```typescript
const batch = repos.users.batch.create();

// Set with document ID
batch.set("user-1", {
  name: "User One",
  email: "user1@example.com",
  age: 25,
  isActive: true,
});

// Update existing
batch.update("user-2", {
  age: 30,
});

// Delete
batch.delete("user-3");

await batch.commit();
```

### Subcollection Batch Operations

```typescript
// For subcollections, pass parent IDs first, then document ID
const batch = repos.comments.batch.create();

batch.set(postId, "comment-1", {
  postId: postId,
  userId: userId,
  content: "First comment",
  likes: 0,
});

batch.set(postId, "comment-2", {
  postId: postId,
  userId: userId,
  content: "Second comment",
  likes: 0,
});

await batch.commit();
```

## Bulk Operations

For processing large amounts of data (automatically split into batches of 500).

```typescript
// Get Firestore instance
const db = getFirestore();

// Bulk Set
await repos.users.bulk.set([
  {
    docRef: db.collection("users").doc("user1"),
    data: {
      name: "User 1",
      email: "user1@example.com",
      age: 25,
      isActive: true,
    },
    merge: true,
  },
  {
    docRef: db.collection("users").doc("user2"),
    data: {
      name: "User 2",
      email: "user2@example.com",
      age: 30,
      isActive: true,
    },
  },
  // ... up to thousands of documents
]);

// Bulk Update
await repos.users.bulk.update([
  { docRef: db.collection("users").doc("user1"), data: { age: 30 } },
  { docRef: db.collection("users").doc("user2"), data: { age: 25 } },
]);

// Bulk Delete
await repos.users.bulk.delete([
  db.collection("users").doc("user1"),
  db.collection("users").doc("user2"),
]);
```

## Real-time Listeners (onSnapshot)

```typescript
// Listen for real-time changes
const unsubscribe = repos.users.query.onSnapshot(
  {
    where: [["isActive", "==", true]],
    orderBy: [{ field: "name", direction: "asc" }],
  },
  (users) => {
    console.log("Updated data:", users);
  },
  (error) => {
    console.error("Error:", error);
  }
);

// Stop listening
unsubscribe();
```

## Cursor Pagination

Cursor-based pagination is more efficient than `offset` for large collections.

```typescript
// First page
const firstPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// Next page using the last document
const lastDoc = firstPage[firstPage.length - 1];
const nextPage = await repos.users.query.by({
  orderBy: [{ field: "createdAt", direction: "desc" }],
  startAfter: lastDoc, // or use an array of values
  limit: 10,
});
```

## Aggregations

```typescript
// Count documents
const totalPosts = await repos.posts.aggregate.count();

// Count with filter
const publishedCount = await repos.posts.aggregate.count({
  where: [["status", "==", "published"]],
});

// Sum a field
const totalViews = await repos.posts.aggregate.sum("views");

// Sum with filter
const publishedViews = await repos.posts.aggregate.sum("views", {
  where: [["status", "==", "published"]],
});

// Average
const avgLikes = await repos.posts.aggregate.average("likes");
```

## Transactions

```typescript
// Transaction with type-safe methods
await repos.categories.transaction.run(async (t) => {
  // Get document in transaction
  const category = await t.get(categoryId);

  if (category) {
    // Update in transaction
    t.update(categoryId, { postCount: category.postCount + 1 });
  }

  // Set in transaction
  t.set("new-category", {
    name: "New Category",
    slug: "new-category",
    postCount: 0,
  });

  // Delete in transaction
  t.delete("old-category");
});
```

## Collection Group Queries

Query across all subcollections with the same name.

```typescript
// Define with isGroup: true
const mapping = {
  comments: createRepositoryConfig<CommentModel>()({
    path: "comments",
    isGroup: true, // Important!
    foreignKeys: ["docId"] as const,
    queryKeys: ["postId", "userId"] as const,
    refCb: (db, postId, commentId) =>
      doc(db, "posts", postId, "comments", commentId),
  }),
};

// Query all comments by a user across all posts
const userComments = await repos.comments.query.byUserId(userId);
```

## Select (Field Projection)

Reduce payload size by selecting only needed fields.

```typescript
// Query with select
const userNames = await repos.users.query.by({
  where: [["isActive", "==", true]],
  select: ["docId", "name", "email"],
});

// Pagination with select
const page = await repos.posts.query.paginate({
  pageSize: 10,
  select: ["docId", "title", "status"],
});

// Include with select (relations)
const pageWithRelations = await repos.posts.query.paginate({
  pageSize: 10,
  include: [{ relation: "userId", select: ["docId", "name"] }],
});
```
