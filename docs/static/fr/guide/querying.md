# Requêtes

## Méthodes GET

Récupère un **document unique** par une clé étrangère (depuis `foreignKeys`).

```typescript
const user  = await repos.users.get.byDocId("user123");
const user2 = await repos.users.get.byEmail("alice@example.com");

// Avec DocumentSnapshot brut
const result = await repos.users.get.byDocId("user123", true);
if (result) {
  console.log(result.data); // UserModel
  console.log(result.doc);  // DocumentSnapshot
}

// Récupération par liste de valeurs
const users = await repos.users.get.byList("docId", ["u1", "u2", "u3"]);
```

## Méthodes QUERY

Recherche **plusieurs documents** par une clé de requête (depuis `queryKeys`).

```typescript
const actifs  = await repos.users.query.byIsActive(true);
const parNom  = await repos.users.query.byName("Alice");

// Avec options avancées
const results = await repos.users.query.byIsActive(true, {
  where:   [["age", ">=", 18]],
  orderBy: [{ field: "name", direction: "asc" }],
  limit:   50,
});

// Requête générique
const users = await repos.users.query.by({
  where: [
    ["isActive", "==", true],
    ["age",      ">=", 18],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit:  10,
  select: ["docId", "name", "email"],
});

// Récupérer tout
const all = await repos.users.query.getAll();
```

## Conditions OR

### `orWhere` — OR simple

Chaque clause est OR'd indépendamment. Les conditions `where` de base sont appliquées à **chaque** branche.

```typescript
// status == "draft" OU status == "published"
const posts = await repos.posts.query.by({
  orWhere: [
    ["status", "==", "draft"],
    ["status", "==", "published"],
  ],
});

// (isActive == true) ET (userId == "A" OU userId == "B")
const posts2 = await repos.posts.query.by({
  where:   [["isActive", "==", true]],  // appliqué à chaque branche
  orWhere: [
    ["userId", "==", "user-A"],
    ["userId", "==", "user-B"],
  ],
});
```

### `orWhereGroups` — OR composé (AND dans chaque groupe)

```typescript
// (status=="published" ET views>100) OU (status=="draft" ET userId=="moi")
const posts = await repos.posts.query.by({
  orWhereGroups: [
    [["status", "==", "published"], ["views", ">", 100]],
    [["status", "==", "draft"],     ["userId", "==", monId]],
  ],
});
```

::: info Sous le capot
Les conditions OR sont simulées en lançant une requête Firestore par branche en parallèle, puis en fusionnant les résultats en mémoire (déduplication par ID).
La limite des 30 disjonctions natives de Firestore ne s'applique pas.

Pour `in` / `array-contains-any` avec >30 valeurs, les valeurs sont automatiquement découpées en chunks de 30 requêtes.
:::

## Référence QueryOptions

```typescript
interface QueryOptions<T> {
  where?:         [keyof T, WhereFilterOp, any][];    // conditions AND
  orWhere?:       [keyof T, WhereFilterOp, any][];    // OR simple (une clause par entrée)
  orWhereGroups?: [keyof T, WhereFilterOp, any][][];  // OR composé (groupes AND)
  orderBy?:       { field: keyof T; direction?: "asc" | "desc" }[];
  limit?:         number;
  offset?:        number;
  select?:        (keyof T)[];                        // projection de champs
  startAt?:       DocumentSnapshot | any[];
  startAfter?:    DocumentSnapshot | any[];
  endAt?:         DocumentSnapshot | any[];
  endBefore?:     DocumentSnapshot | any[];
}
```

## Pagination

Pagination basée sur curseur — efficace pour les grandes collections.

```typescript
// Première page
const page1 = await repos.posts.query.paginate({
  pageSize: 10,
  orderBy:  [{ field: "createdAt", direction: "desc" }],
});

// Page suivante
const page2 = await repos.posts.query.paginate({
  pageSize:  10,
  cursor:    page1.nextCursor,
  direction: "next",
});

// Page précédente
const prev = await repos.posts.query.paginate({
  pageSize:  10,
  cursor:    page2.prevCursor,
  direction: "prev",
});
```

### Paginer avec filtres et OR

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  where:   [["status", "==", "published"]],
  orWhere: [
    ["userId",   "==", monId],
    ["featured", "==", true],
  ],
  orderBy: [{ field: "createdAt", direction: "desc" }],
});
```

### Paginer avec `include` (populate par page)

```typescript
const page = await repos.posts.query.paginate({
  pageSize: 10,
  include: [
    "docId",                                            // many → CommentModel[]
    { relation: "userId", select: ["docId", "name"] }, // one  → UserModel partiel
  ],
});

for (const post of page.data) {
  console.log(post.populated.docId);  // CommentModel[]
  console.log(post.populated.userId); // { docId, name }
}
```

## Itérer toutes les pages — `paginateAll`

Générateur async qui avance automatiquement les curseurs. Idéal pour les migrations et exports.

```typescript
for await (const page of repos.posts.query.paginateAll({ pageSize: 100 })) {
  console.log(`${page.data.length} posts sur cette page`);
}

// Avec include
for await (const page of repos.posts.query.paginateAll({
  pageSize: 100,
  include:  [{ relation: "userId", select: ["name"] }],
})) {
  for (const post of page.data) {
    console.log(post.populated.userId?.name);
  }
}
```

## Listener temps réel

```typescript
const unsub = repos.users.query.onSnapshot(
  { where: [["isActive", "==", true]] },
  (users) => console.log(users),
  (err)   => console.error(err),
);

unsub(); // arrêter le listener
```
