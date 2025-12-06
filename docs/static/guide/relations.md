# Relations & Populate

The library provides a powerful type-safe way to handle relationships between documents.

## Defining Relations

Use `buildRepositoryRelations` to define relationships between your repositories. This step is optional but required if you want to use the `populate` method.

```typescript
import { buildRepositoryRelations } from "@lpdjs/firestore-repo-service";

// 1. Define your base mapping
const repositoryMapping = {
  users: createRepositoryConfig<UserModel>()({ ... }),
  posts: createRepositoryConfig<PostModel>()({ ... }),
};

// 2. Define relations
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  posts: {
    // Define a relation on the 'userId' field of PostModel
    userId: {
      repo: "users",      // Target repository name
      key: "docId",       // Target foreign key
      type: "one" as const // Relation type: "one" or "many"
    },
  },
});

// 3. Create the service
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

::: tip Type Safety
The `buildRepositoryRelations` function validates that:

1. The repository names exist in your mapping.
2. The foreign keys exist in the target repository configuration.
3. The relation keys exist in your source model.
   :::

## Using Populate

Once relations are defined, you can use the `populate` method on any document retrieved from the repository.

### One-to-One Relation

```typescript
// Get a post
const post = await repos.posts.get.byDocId("post_123");

if (post) {
  // Populate the 'userId' field
  const postWithUser = await repos.posts.populate(post, "userId");

  // Access the populated data
  // The type is automatically inferred as UserModel | null
  console.log(postWithUser.populated.users?.name);

  // The original document data is still available
  console.log(postWithUser.title);
}
```

### Populating Multiple Fields

You can populate multiple fields at once by passing an array of keys.

```typescript
const postWithRelations = await repos.posts.populate(post, [
  "userId",
  "categoryId",
]);

console.log(postWithRelations.populated.users?.name);
console.log(postWithRelations.populated.categories?.name);
```

### Populate with Select (Field Projection)

You can limit which fields are returned from the related documents using `select`. This is useful for reducing payload size.

```typescript
// Single relation with select
const userWithPosts = await repos.users.populate(
  { docId: user.docId },
  {
    relation: "docId",
    select: ["docId", "title", "status"], // Type-safe: keyof PostModel
  }
);

// Multiple relations with select per relation
const postWithRelations = await repos.posts.populate(post, {
  relations: ["userId", "categoryId"],
  select: {
    userId: ["docId", "name", "email"],
    categoryId: ["docId", "name"],
  },
});
```

::: tip Type Safety
The `select` array is typed to `keyof TargetModel`, so you get autocomplete and compile-time validation for the fields you can select.
:::

### Populating Lists

You can also populate documents from a list query.

```typescript
const posts = await repos.posts.query.getAll();

for (const post of posts) {
  const populated = await repos.posts.populate(post, "userId");
  console.log(`${populated.title} by ${populated.populated.users?.name}`);
}
```

### Pagination with Include

For paginated queries, use `include` instead of `populate` to automatically populate relations for all results.

```typescript
// Basic include
const page = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy: [{ field: "createdAt", direction: "desc" }],
  include: ["userId"], // Include author for each post
});

// Access populated data
for (const post of page.data) {
  console.log(post.title);
  console.log(post.populated.users?.name); // Type-safe!
}

// Include with select (field projection)
const pageWithSelect = await repos.posts.query.paginate({
  pageSize: 10,
  include: [
    { relation: "userId", select: ["docId", "name", "email"] },
    { relation: "docId", select: ["content"] }, // Comments
  ],
});
```

````

## Type Inference

The `populate` method returns a new object type that includes a `populated` property. This property contains the resolved documents, keyed by the target repository name.

```typescript
// Inferred type structure:
// {
//   ...PostModel,
//   populated: {
//     users: UserModel | null
//   }
// }
````

If the relation type is `"many"`, the inferred type will be an array:

```typescript
// If type: "many"
// populated: {
//   comments: CommentModel[]
// }
```

## Exported Types

```typescript
import type {
  // Basic populate options (untyped select)
  PopulateOptions,

  // Typed populate options with keyof select
  PopulateOptionsTyped,

  // Basic include config for pagination
  IncludeConfig,

  // Typed include config with keyof select
  IncludeConfigTyped,

  // Pagination options with typed include
  PaginationWithIncludeOptionsTyped,
} from "@lpdjs/firestore-repo-service";
```

### PopulateOptionsTyped

```typescript
// Typed populate with select based on target model
type PopulateOptionsTyped<TRelationalKeys, K extends keyof TRelationalKeys> =
  | {
      relation: K;
      select?: (keyof ExtractTargetModel<TRelationalKeys[K]>)[];
    }
  | {
      relations: K | K[];
      select?: {
        [P in K]?: (keyof ExtractTargetModel<TRelationalKeys[P]>)[];
      };
    };
```

### IncludeConfigTyped

```typescript
// Typed include for pagination with select
type IncludeConfigTyped<TRelationalKeys, K extends keyof TRelationalKeys> = {
  relation: K;
  select?: (keyof ExtractTargetModel<TRelationalKeys[K]>)[];
};
```
