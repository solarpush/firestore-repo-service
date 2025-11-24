# Advanced Usage

## Batch Operations

For atomic operations (max 500 operations).

```typescript
const batch = repos.users.batch.create();

batch.set(repos.users.documentRef("user1"), {
  name: "User One",
  email: "user1@example.com",
});

batch.update(repos.users.documentRef("user2"), {
  age: 25,
});

batch.delete(repos.users.documentRef("user3"));

await batch.commit();
```

## Bulk Operations

For processing large amounts of data (automatically split into batches of 500).

```typescript
// Bulk Set
await repos.users.bulk.set([
  {
    docRef: repos.users.documentRef("user1"),
    data: { name: "User 1", email: "user1@example.com" },
    merge: true,
  },
  {
    docRef: repos.users.documentRef("user2"),
    data: { name: "User 2", email: "user2@example.com" },
  },
  // ... up to thousands of documents
]);

// Bulk Update
await repos.users.bulk.update([
  { docRef: repos.users.documentRef("user1"), data: { age: 30 } },
  { docRef: repos.users.documentRef("user2"), data: { age: 25 } },
]);

// Bulk Delete
await repos.users.bulk.delete([
  repos.users.documentRef("user1"),
  repos.users.documentRef("user2"),
]);
```

## Real-time Listeners (onSnapshot)

```typescript
// Listen for real-time changes
const unsubscribe = repos.users.query.onSnapshot(
  {
    where: [{ field: "isActive", operator: "==", value: true }],
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
import { count, sum, average } from "@lpdjs/firestore-repo-service";

// Count documents
const activeCount = await repos.users.aggregate.count({
  where: [{ field: "isActive", operator: "==", value: true }],
});

// Custom aggregations (count, sum, average)
const stats = await repos.users.aggregate.query(
  {
    totalUsers: count(),
    totalAge: sum("age"),
    averageAge: average("age"),
  },
  {
    where: [{ field: "isActive", operator: "==", value: true }],
  }
);

console.log(stats.totalUsers); // total count
console.log(stats.totalAge); // sum of ages
console.log(stats.averageAge); // average age
```
