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

### Populating Lists

You can also populate documents from a list query.

```typescript
const posts = await repos.posts.query.getAll();

for (const post of posts) {
  const populated = await repos.posts.populate(post, "userId");
  console.log(`${populated.title} by ${populated.populated.users?.name}`);
}
```

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
```

If the relation type is `"many"`, the inferred type will be an array:

```typescript
// If type: "many"
// populated: {
//   comments: CommentModel[]
// }
```
