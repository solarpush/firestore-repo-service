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
// db résolu paresseusement au premier accès — jamais à l'import.
export const repos = createRepositoryMapping(() => getFirestore(), mappingWithRelations);
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
| `system`      | `backfillKeys(options?)`              | Backfill des champs système auto-gérés     |
| `populate`    | `(doc, key \| options)`               | Peupler les documents liés                 |
| `aggregate`   | `count / sum / average`               | Agrégations côté serveur                   |
| `transaction` | `run(callback)`                       | Transaction Firestore                      |

## Champs système & `system.backfillKeys()`

Les clés de config optionnelles `documentKey`, `pathKey`, `createdKey` et
`updatedKey` sont **auto-gérées** : le package les écrit à chaque opération
`create` / `set` / `update` / `batch` / `bulk`. Les documents écrits **hors**
package (données legacy, imports manuels) peuvent en manquer — avec des
conséquences :

- **`pathKey` manquant** — le serveur CRUD / admin reconstruit le chemin d'un
  document depuis ce champ pour le `update` / `delete`. Sans lui, **les
  documents en sous-collection / collectionGroup ne peuvent plus être mis à jour
  ou supprimés via le serveur** (les collections racines fonctionnent toujours).
- **`createdKey` / `updatedKey` manquant** — tout `query.getAll({ orderBy: [[...]] })`
  sur ce champ **exclut silencieusement** les documents qui ne l'ont pas
  (Firestore omet les documents sans le champ d'`orderBy`).
- **`documentKey` manquant** — les lectures directes (`get.by{DocumentKey}`)
  fonctionnent toujours (elles utilisent la référence du document), mais la clé
  primaire de la sync BigQuery peut être nulle.

`system.backfillKeys()` répare les documents legacy. Il parcourt toute la
collection (paginé) et ne remplit que les documents qui en ont besoin :

- `pathKey` ← le `ref.path` réel du document (le chemin **complet** imbriqué,
  pour que les docs sous-collection / collectionGroup redeviennent modifiables
  via le serveur),
- `documentKey` ← `doc.id` si absent,
- `createdKey` ← `now()` **uniquement si absent** (horodatages existants
  préservés),
- `updatedKey` ← `now()` **uniquement si absent**.

La méthode est idempotente et minimise les écritures (les documents déjà
complets sont ignorés), donc relançable sans risque.

```typescript
// Migrer les documents legacy en place.
const { scanned, written, skipped, failures } =
  await repos.residences.system.backfillKeys();

// Prévisualiser sans écrire.
const preview = await repos.residences.system.backfillKeys({ dryRun: true });

// Observer les échecs partiels au lieu de lever une erreur.
await repos.residences.system.backfillKeys({
  pageSize: 500,
  onError: ({ path, error }) => console.error(path, error.message),
  onSuccess: (path) => metrics.inc("backfilled"),
});
```

| Option             | Défaut  | Description                                              |
|--------------------|---------|----------------------------------------------------------|
| `overwriteCreated` | `false` | Réécrit `createdKey` même s'il est déjà présent          |
| `touchUpdated`     | `true`  | Remplit `updatedKey` avec now s'il est absent            |
| `overwritePath`    | `false` | Réécrit toujours `pathKey` depuis le ref path réel       |
| `pageSize`         | `300`   | Documents récupérés par page                             |
| `dryRun`           | `false` | Compte ce qui changerait sans écrire                     |
| `maxAttempts`      | `5`     | Tentatives par document pour les erreurs retryables      |
| `onError`          | —       | Appelé une fois par document définitivement en échec     |
| `onSuccess`        | —       | Appelé une fois par document patché avec succès          |

Retourne `{ scanned, written, skipped, failures }`.
