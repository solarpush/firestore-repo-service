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

## Gestion des dates (`setDateHandling`)

Firestore stocke les dates en `Timestamp`. Par défaut le SDK les retourne tels
quels en lecture — pratique en JS pur, mais pénible pour les API JSON,
l'OpenAPI, BigQuery, ou tout code qui attend du `Date` natif / des ISO strings.

`setDateHandling()` est un switch global avec deux modes :

```typescript
import { setDateHandling } from "@lpdjs/firestore-repo-service";

// Au démarrage de ton app (init serveur, init function, etc.)
setDateHandling("normalize"); // ou "preserve"
```

### `"preserve"` (défaut — non-breaking)

Comportement inchangé :

- Les lectures du repo renvoient des `Timestamp` bruts.
- La validation CRUD `z.date()` reste stricte (rejette les ISO strings).
- La sortie JSON CRUD peut contenir `{ _seconds, _nanoseconds }` si tu laisses
  passer un `Timestamp`.

À choisir si ton code manipule déjà des `Timestamp` et que tu ne veux aucun
changement de comportement.

### `"normalize"` (recommandé pour les nouveaux projets)

Tout converge sur **`Date` JS** côté code et **ISO 8601** sur le réseau :

| Couche                                    | Comportement                                                                     |
|-------------------------------------------|----------------------------------------------------------------------------------|
| `get.by*`, `getAll`, `query.by*`          | Conversion récursive `Timestamp` → `Date` (objets/arrays imbriqués inclus).      |
| `paginate`, `transaction.get`             | Même normalisation récursive.                                                    |
| Retours `create`, `set`, `update`         | Même normalisation récursive.                                                    |
| Validation d'entrée CRUD                  | `z.date()` est wrappé en `z.preprocess(coerceToDate)` et accepte : `Date`, `Timestamp`, ISO string, `{_seconds,_nanoseconds}`, epoch ms. |
| Sortie JSON CRUD                          | `Date` → ISO string (natif), plus de fuite `{_seconds,_nanoseconds}`.            |
| OpenAPI                                   | `z.date()` documenté en `string` / `format: date-time` (matche le runtime).      |
| Sync BigQuery                             | Inchangé — fonctionne identiquement avec `Date` ou `Timestamp`.                  |
| Serveur Admin                             | Inchangé — déjà défensif (gère tous les formats).                                |

### Helpers

Les utilitaires de conversion sont exportés au cas où tu en aurais besoin manuellement :

```typescript
import {
  coerceToDate,
  normalizeTimestamps,
  getDateHandling,
} from "@lpdjs/firestore-repo-service";

// Date | Timestamp | ISO | epoch ms | {_seconds,_nanoseconds} -> Date | null
const d = coerceToDate(req.body.publishedAt);

// Convertit récursivement les Timestamps en Dates
const normalized = normalizeTimestamps(somePayload);

// Lecture du mode global courant
getDateHandling(); // "preserve" | "normalize"
```
