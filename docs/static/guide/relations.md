# Relations & Populate

## Defining relations

```typescript
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  users: {
    docId: { repo: "posts", key: "userId", type: "many" as const },
  },
  posts: {
    userId: { repo: "users",    key: "docId",  type: "one"  as const },
    docId:  { repo: "comments", key: "postId", type: "many" as const },
  },
  comments: {
    postId: { repo: "posts", key: "docId", type: "one" as const },
    userId: { repo: "users", key: "docId", type: "one" as const },
  },
});
```

Each entry maps a field in the source model to a target repository:

| Field          | Description                                    |
|----------------|------------------------------------------------|
| `repo`         | Name of the target repository                  |
| `key`          | Field on the target repo used for the lookup   |
| `type: "one"`  | The field holds a single ID → returns one doc  |
| `type: "many"` | The field holds an ID used to filter → returns array |

## `populate()` — on a single document

```typescript
const post = await repos.posts.get.byDocId("post_1");

// One relation key
const withAuthor = await repos.posts.populate(post!, "userId");
console.log(withAuthor.populated.userId); // UserModel | null

// One relation with field projection
const withAuthorPartial = await repos.posts.populate(post!, {
  relation: "userId",
  select: ["docId", "name", "email"], // typed to UserModel keys
});

// Multiple relations
const full = await repos.posts.populate(post!, ["userId", "docId"]);
console.log(full.populated.userId); // UserModel | null
console.log(full.populated.docId);  // CommentModel[]
```

::: tip Naming
The populated result is keyed by the **source field name** (not the target repo name).
`post.populated.userId` → the user, `post.populated.docId` → the comments.
:::

## `include` — populate during pagination

Use `include` in `paginate` or `paginateAll` to populate all relations for every document of the page:

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  include: [
    "docId",                                              // comments (many)
    { relation: "userId", select: ["docId", "name"] },   // author (one), partial
  ],
});

for (const post of page.data) {
  console.log(post.populated.docId);  // CommentModel[]
  console.log(post.populated.userId); // { docId: string; name: string }
}
```

Works the same with `paginateAll`:

```typescript
for await (const page of repos.posts.query.paginateAll({
  pageSize: 100,
  include:  ["userId"],
})) {
  // page.data[n].populated.userId is populated
}
```

## Exported types

```typescript
import type {
  PopulateOptionsTyped,          // typed populate options with keyof select
  IncludeConfigTyped,            // typed include config for pagination
  PaginationWithIncludeOptionsTyped, // full pagination + include options
} from "@lpdjs/firestore-repo-service";
```
