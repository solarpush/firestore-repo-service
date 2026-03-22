# Configuration

## `createRepositoryConfig()`

| Paramètre     | Type       | Défaut            | Description                                           |
|---------------|------------|-------------------|-------------------------------------------------------|
| `path`        | `string`   | —                 | Chemin de la collection Firestore                     |
| `isGroup`     | `boolean`  | —                 | `true` pour les requêtes de collection group          |
| `foreignKeys` | `string[]` | —                 | Clés pour les méthodes `get.by*`                       |
| `queryKeys`   | `string[]` | —                 | Clés pour les méthodes `query.by*`                     |
| `refCb`       | Function   | —                 | Construit la `DocumentReference`                      |
| `documentKey` | `string`   | `"docId"`         | Champ injecté automatiquement avec l'ID Firestore     |
| `pathKey`     | `string`   | `"documentPath"`  | Champ injecté avec le chemin complet Firestore        |
| `createdKey`  | `string`   | `"createdAt"`     | Champ rempli à la création                            |
| `updatedKey`  | `string`   | `"updatedAt"`     | Champ mis à jour à chaque écriture                    |

### Collection simple

```typescript
users: createRepositoryConfig(userSchema)({
  path:        "users",
  isGroup:     false,
  foreignKeys: ["docId", "email"] as const,
  queryKeys:   ["isActive", "name"] as const,
  documentKey: "docId",
  pathKey:     "documentPath",
  createdKey:  "createdAt",
  updatedKey:  "updatedAt",
  refCb: (db: Firestore, docId: string) => db.collection("users").doc(docId),
});
```

### Sous-collection

`refCb` reçoit les IDs parents dans l'ordre, puis l'ID du document en dernier.

```typescript
comments: createRepositoryConfig<CommentModel>()({
  path:        "comments",
  isGroup:     true,
  foreignKeys: ["docId", "postId", "userId"] as const,
  queryKeys:   ["postId", "userId"] as const,
  documentKey: "docId",
  pathKey:     "documentPath",
  refCb: (db: Firestore, postId: string, commentId: string) =>
    db.collection("posts").doc(postId).collection("comments").doc(commentId),
});
```

## `buildRepositoryRelations()`

Déclare les relations entre repositories.

```typescript
const mappingWithRelations = buildRepositoryRelations(repositoryMapping, {
  users: {
    docId:  { repo: "posts",    key: "userId", type: "many" as const },
  },
  posts: {
    userId: { repo: "users",    key: "docId",  type: "one"  as const },
    docId:  { repo: "comments", key: "postId", type: "many" as const },
  },
  comments: {
    postId: { repo: "posts",    key: "docId",  type: "one" as const },
    userId: { repo: "users",    key: "docId",  type: "one" as const },
  },
});
```

## `createRepositoryMapping()`

```typescript
const db = getFirestore();
export const repos = createRepositoryMapping(db, mappingWithRelations);
```

## Méthodes générées

| Namespace     | Méthode                               | Description                                |
|---------------|---------------------------------------|--------------------------------------------|
| (racine)      | `create(data)`                        | Créer avec ID auto                         |
| (racine)      | `set(id, data, options?)`             | Créer / remplacer avec ID spécifique       |
| (racine)      | `update(id, data)`                    | Mise à jour partielle                      |
| (racine)      | `delete(id)`                          | Supprimer un document                      |
| `get`         | `by{ForeignKey}(value)`               | Récupérer un document unique               |
| `get`         | `byList(key, values[])`               | Récupérer plusieurs documents par liste    |
| `query`       | `by{QueryKey}(value, options?)`       | Requêter par clé                           |
| `query`       | `by(options)`                         | Requête générique (options complètes)      |
| `query`       | `getAll(options?)`                    | Récupérer tous les documents               |
| `query`       | `paginate(options)`                   | Pagination basée sur curseur               |
| `query`       | `paginateAll(options)`                | Générateur async sur toutes les pages      |
| `query`       | `onSnapshot(options, cb, errCb?)`     | Listener temps réel                        |
| `batch`       | `create()`                            | Batch atomique (max 500 opérations)        |
| `bulk`        | `set / update / delete`               | Opérations bulk (auto-découpées)           |
| `populate`    | `(doc, key \| options)`               | Peupler les documents liés                 |
| `aggregate`   | `count / sum / average`               | Agrégations côté serveur                   |
| `transaction` | `run(callback)`                       | Transaction Firestore                      |
