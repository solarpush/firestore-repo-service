# Querying

## GET Methods

Retrieve a **single document** by a foreign key.

```typescript
const user  = await repos.users.get.byDocId("user123");
const user2 = await repos.users.get.byEmail("alice@example.com");

// With raw DocumentSnapshot
const result = await repos.users.get.byDocId("user123", true);
if (result) {
  console.log(result.data); // UserModel
  console.log(result.doc);  // DocumentSnapshot
}

// Batch get
const users = await repos.users.get.byList("docId", ["u1", "u2", "u3"]);
```

## QUERY Methods

Search for **multiple documents** by a query key.

```typescript
const activeUsers = await repos.users.query.byIsActive(true);
const byName      = await repos.users.query.byName("Alice");

// With extra options
const results = await repos.users.query.byIsActive(true, {
  where:   [["age", ">=", 18]],
  orderBy: [{ field: "name", direction: "asc" }],
  limit:   50,
});

// Generic query
const users = await repos.users.query.by({
  where: [
    ["isActive", "==", true],
    ["age",      ">=", 18],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit:  10,
  select: ["docId", "name", "email"],
});

// Get all
const all = await repos.users.query.getAll();
```

## OR Conditions

### `orWhere` — simple OR

Each clause is independently OR'd. Base `where` conditions are applied to **every** branch.

```typescript
// status == "draft" OR status == "published"
const posts = await repos.posts.query.by({
  orWhere: [
    ["status", "==", "draft"],
    ["status", "==", "published"],
  ],
});

// (isActive == true) AND (userId == "A"  OR  userId == "B")
const posts2 = await repos.posts.query.by({
  where:   [["isActive", "==", true]],  // applied to every branch
  orWhere: [
    ["userId", "==", "user-A"],
    ["userId", "==", "user-B"],
  ],
});
```

### `orWhereGroups` — compound OR (AND-within-OR)

```typescript
// (status=="published" AND views>100) OR (status=="draft" AND userId=="me")
const posts = await repos.posts.query.by({
  orWhereGroups: [
    [["status", "==", "published"], ["views", ">", 100]],
    [["status", "==", "draft"],     ["userId", "==", myId]],
  ],
});
```

::: info Under the hood
OR conditions are simulated by running one Firestore query per branch in parallel, then merging results in memory (dedup by document ID). No 30-disjunction limit applies.

`in` / `array-contains-any` operators with >30 values are automatically split into chunks of 30 queries.
:::

## QueryOptions reference

```typescript
interface QueryOptions<T> {
  where?:         [keyof T, WhereFilterOp, any][];    // AND conditions
  orWhere?:       [keyof T, WhereFilterOp, any][];    // simple OR (one clause per entry)
  orWhereGroups?: [keyof T, WhereFilterOp, any][][];  // compound OR (AND groups)
  orderBy?:       { field: keyof T; direction?: "asc" | "desc" }[];
  limit?:         number;
  offset?:        number;
  select?:        (keyof T)[];                        // field projection
  startAt?:       DocumentSnapshot | any[];
  startAfter?:    DocumentSnapshot | any[];
  endAt?:         DocumentSnapshot | any[];
  endBefore?:     DocumentSnapshot | any[];
}
```

## Pagination

Cursor-based pagination — efficient for large collections.

```typescript
// First page
const page1 = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy:  [{ field: "createdAt", direction: "desc" }],
});

// page1.data         → PostModel[]
// page1.hasNextPage  → boolean
// page1.hasPrevPage  → boolean
// page1.nextCursor   → DocumentSnapshot | undefined
// page1.prevCursor   → DocumentSnapshot | undefined

// Next page
const page2 = await repos.posts.query.paginate({
  pageSize:  10,
  cursor:    page1.nextCursor,
  direction: "next",  // default
});

// Previous page
const prev = await repos.posts.query.paginate({
  pageSize:  10,
  cursor:    page2.prevCursor,
  direction: "prev",
});
```

### Paginate with filters and OR

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  where:   [["status", "==", "published"]],
  orWhere: [
    ["userId", "==", currentUserId],
    ["featured", "==", true],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
});
```

### Paginate with `include` (populate relations per page)

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  include: [
    "docId",                                           // many → CommentModel[]
    { relation: "userId", select: ["docId", "name"] }, // one  → partial UserModel
  ],
});

for (const post of page.data) {
  console.log(post.populated.docId);  // CommentModel[]
  console.log(post.populated.userId); // { docId, name }
}
```

## Iterate all pages — `paginateAll`

Async generator that automatically advances cursors. Ideal for migrations and exports.

```typescript
for await (const page of repos.posts.query.paginateAll({ pageSize: 100 })) {
  console.log(`${page.data.length} posts on this page`);
}

// With include
for await (const page of repos.posts.query.paginateAll({
  pageSize: 100,
  include:  [{ relation: "userId", select: ["name"] }],
})) {
  for (const post of page.data) {
    console.log(post.populated.userId?.name);
  }
}
```

## Real-time listener

```typescript
const unsub = repos.users.query.onSnapshot(
  { where: [["isActive", "==", true]] },
  (users) => console.log(users),
  (err)   => console.error(err),
);

unsub(); // stop listening
```
