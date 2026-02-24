# Relations & Populate

## Définir les relations

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

| Champ           | Description                                               |
|-----------------|-----------------------------------------------------------|
| `repo`          | Nom du repository cible                                   |
| `key`           | Champ du repository cible utilisé pour la recherche      |
| `type: "one"`   | Le champ contient un ID unique → retourne un document    |
| `type: "many"`  | Le champ est utilisé comme filtre → retourne un tableau  |

## `populate()` — sur un document unique

```typescript
const post = await repos.posts.get.byDocId("post_1");

// Une clé de relation
const withAuthor = await repos.posts.populate(post!, "userId");
console.log(withAuthor.populated.userId); // UserModel | null

// Avec projection de champs
const withPartialAuthor = await repos.posts.populate(post!, {
  relation: "userId",
  select: ["docId", "name", "email"],
});

// Plusieurs relations
const full = await repos.posts.populate(post!, ["userId", "docId"]);
console.log(full.populated.userId); // UserModel | null
console.log(full.populated.docId);  // CommentModel[]
```

::: tip Nommage
Le résultat populé est indexé par le **nom du champ source** (pas le nom du repo cible).
`post.populated.userId` → l'auteur, `post.populated.docId` → les commentaires.
:::

## `include` — populate pendant la pagination

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  include: [
    "docId",                                               // commentaires (many)
    { relation: "userId", select: ["docId", "name"] },    // auteur (one), partiel
  ],
});

for (const post of page.data) {
  console.log(post.populated.docId);  // CommentModel[]
  console.log(post.populated.userId); // { docId: string; name: string }
}
```

Fonctionne aussi avec `paginateAll` :

```typescript
for await (const page of repos.posts.query.paginateAll({
  pageSize: 100,
  include:  ["userId"],
})) {
  // page.data[n].populated.userId est peuplé
}
```
