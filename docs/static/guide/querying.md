# Querying

## GET Methods

Retrieve a **single document** by a foreign key.

```typescript
// Auto-generated methods from foreignKeys
const user = await repos.users.get.byDocId("user123");
const userByEmail = await repos.users.get.byEmail("john@example.com");

// With DocumentSnapshot
const result = await repos.users.get.byDocId("user123", true);
if (result) {
  console.log(result.data); // UserModel
  console.log(result.doc); // DocumentSnapshot
}

// Get by list of values
const users = await repos.users.get.byList("docId", [
  "user1",
  "user2",
  "user3",
]);
```

## QUERY Methods

Search for **multiple documents** by a query key.

```typescript
// Auto-generated methods from queryKeys
const activeUsers = await repos.users.query.byIsActive(true);
const usersByName = await repos.users.query.byName("John");

// With options
const results = await repos.users.query.byIsActive(true, {
  where: [{ field: "age", operator: ">=", value: 18 }],
  orderBy: [{ field: "name", direction: "asc" }],
  limit: 50,
});

// Generic query
const users = await repos.users.query.by({
  where: [
    { field: "isActive", operator: "==", value: true },
    { field: "age", operator: ">=", value: 18 },
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// OR conditions
const posts = await repos.posts.query.by({
  orWhere: [
    [{ field: "status", operator: "==", value: "published" }],
    [{ field: "status", operator: "==", value: "draft" }],
  ],
});
```

## Query Options

```typescript
interface QueryOptions<T> {
  where?: WhereClause<T>[]; // AND conditions
  orWhere?: WhereClause<T>[][]; // OR conditions
  orderBy?: {
    field: keyof T;
    direction?: "asc" | "desc";
  }[];
  limit?: number; // Max results
  offset?: number; // Pagination (skip)
  startAt?: DocumentSnapshot | any[]; // Cursor pagination - start at
  startAfter?: DocumentSnapshot | any[]; // Cursor pagination - start after
  endAt?: DocumentSnapshot | any[]; // Cursor pagination - end at
  endBefore?: DocumentSnapshot | any[]; // Cursor pagination - end before
}
```
