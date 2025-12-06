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

// With options (tuple syntax for where)
const results = await repos.users.query.byIsActive(true, {
  where: [["age", ">=", 18]], // Tuple: [field, operator, value]
  orderBy: [{ field: "name", direction: "asc" }],
  limit: 50,
});

// Generic query
const users = await repos.users.query.by({
  where: [
    ["isActive", "==", true],
    ["age", ">=", 18],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 10,
});

// OR conditions
const posts = await repos.posts.query.by({
  orWhere: [[["status", "==", "published"]], [["status", "==", "draft"]]],
});

// With select (field projection)
const userNames = await repos.users.query.by({
  where: [["isActive", "==", true]],
  select: ["docId", "name", "email"], // Only return these fields
});
```

## Query Options

```typescript
// WhereClause as tuple: [field, operator, value]
type WhereClause<T> = [keyof T, WhereFilterOp, any];

interface QueryOptions<T> {
  where?: WhereClause<T>[]; // AND conditions - tuples [field, op, value]
  orWhere?: WhereClause<T>[][]; // OR conditions
  orderBy?: {
    field: keyof T;
    direction?: "asc" | "desc";
  }[];
  limit?: number; // Max results
  offset?: number; // Pagination (skip)
  select?: (keyof T)[]; // Field projection
  startAt?: DocumentSnapshot | any[]; // Cursor pagination - start at
  startAfter?: DocumentSnapshot | any[]; // Cursor pagination - start after
  endAt?: DocumentSnapshot | any[]; // Cursor pagination - end at
  endBefore?: DocumentSnapshot | any[]; // Cursor pagination - end before
}
```

## Pagination

```typescript
// Basic pagination
const page1 = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy: [{ field: "createdAt", direction: "desc" }],
});

console.log(page1.data); // PostModel[]
console.log(page1.hasNextPage); // boolean
console.log(page1.nextCursor); // cursor for next page

// Next page
const page2 = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy: [{ field: "createdAt", direction: "desc" }],
  cursor: page1.nextCursor,
});

// Pagination with include (relations)
const pageWithRelations = await repos.posts.query.paginate({
  pageSize: 10,
  include: ["userId"], // Include author for each post
});

// Access populated data
for (const post of pageWithRelations.data) {
  console.log(post.title);
  console.log(post.populated.users?.name); // Type-safe!
}

// Include with select (field projection on relations)
const pageWithSelect = await repos.posts.query.paginate({
  pageSize: 10,
  include: [{ relation: "userId", select: ["docId", "name", "email"] }],
});
```
