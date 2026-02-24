# Usage avancé

## CRUD `set()`

Crée ou remplace un document avec un ID spécifique.
`documentKey` et `pathKey` sont injectés automatiquement (comme `create()`).

```typescript
const post = await repos.posts.set("mon-post", {
  title: "Hello",
  status: "draft",
  userId: "user_1",
});
console.log(post.docId);        // "mon-post"
console.log(post.documentPath); // "posts/mon-post"

// Avec merge
await repos.posts.set("mon-post", { title: "Mis à jour" }, { merge: true });
```

## Opérations Batch

Écriture atomique, maximum 500 opérations.

```typescript
const batch = repos.posts.batch.create();

batch.set("post-1", { title: "Post 1", userId: "u1", status: "draft" });
batch.set("post-2", { title: "Post 2", userId: "u1", status: "published" });
batch.update("post-3", { status: "published" });
batch.delete("post-ancien");

await batch.commit();
```

### Batch sur sous-collection

```typescript
const batch = repos.comments.batch.create();
batch.set(postId, "comment-1", { postId, userId, content: "Salut !", likes: 0 });
batch.set(postId, "comment-2", { postId, userId, content: "Monde !", likes: 0 });
await batch.commit();
```

## Opérations Bulk

Découpées automatiquement en batches de 500.

```typescript
const db = getFirestore();

await repos.users.bulk.set([
  { docRef: db.collection("users").doc("u1"), data: { name: "Alice" }, merge: true },
  { docRef: db.collection("users").doc("u2"), data: { name: "Bob" } },
]);

await repos.users.bulk.update([
  { docRef: db.collection("users").doc("u1"), data: { age: 30 } },
]);

await repos.users.bulk.delete([
  db.collection("users").doc("u1"),
]);
```

## Agrégations

Exécutées côté serveur Firestore — aucun document transféré.

```typescript
const total  = await repos.users.aggregate.count();
const actifs = await repos.users.aggregate.count({ where: [["isActive", "==", true]] });
const somme  = await repos.users.aggregate.sum("age");
const moy    = await repos.users.aggregate.average("age", { where: [["isActive", "==", true]] });
```

## Transactions

```typescript
await repos.users.transaction.run(async (tx) => {
  const user = await tx.get("user_1");
  if (!user) throw new Error("introuvable");
  await tx.update("user_1", { age: user.age + 1 });
});
```

## Listener temps réel

```typescript
const unsub = repos.users.query.onSnapshot(
  { where: [["isActive", "==", true]], orderBy: [{ field: "name" }] },
  (users) => console.log("live:", users),
  (err)   => console.error(err),
);
unsub();
```

## Patterns OR avancés

```typescript
// OR simple
await repos.posts.query.by({
  where:   [["isPublic", "==", true]],
  orWhere: [
    ["userId",   "==", "user-A"],
    ["authorId", "==", "user-A"],
  ],
});

// OR composé : (A ET B) OU (C ET D)
await repos.posts.query.by({
  orWhereGroups: [
    [["status", "==", "published"], ["views", ">", 1000]],
    [["status", "==", "featured"],  ["pinned", "==", true]],
  ],
});
```

## Opérateur `in` avec >30 valeurs

```typescript
const ids = Array.from({ length: 90 }, (_, i) => `id-${i}`);

// Génère 3 requêtes Firestore (30+30+30) fusionnées en mémoire
const docs = await repos.users.query.by({
  where: [["docId", "in", ids]],
});
```
