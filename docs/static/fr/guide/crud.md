# Serveur CRUD

Le serveur API REST CRUD est construit via `createServers(repos).crud(...)` — une factory unifiée qui expose automatiquement des endpoints RESTful et des requêtes avancées pour l'ensemble des repositories enregistrés.

**Fonctionnalités :**
- Endpoints REST auto-générés (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
- Endpoint de requête avancée (`POST /:repoName/query`) avec `where`, `orWhere`, `orWhereGroups` et `includes`
- Endpoint d'opérations atomic batch (`POST /:repoName/batch`)
- Décompte total côté serveur (`withTotal`) optimisé par l'agrégation Firestore `.count()`
- Spécification OpenAPI 3.1 automatique (`/openapi.json`) et interface de documentation Scalar (`/docs`)
- Validation des payloads d'entrée via les schemas Zod
- Support des middlewares Hono (Authentification, logs, CORS, rate-limiting)

---

## Configuration de base

```typescript
import { onRequest } from "firebase-functions/v2/https";
import { createServers } from "@lpdjs/firestore-repo-service";

const servers = createServers(repos, {
  onRequest,
  httpsOptions: { invoker: "public" },
});

export const api = servers.crud({
  basePath: "/api",
  middlewares: [
    async (c, next) => {
      // Logique d'authentification / middleware personnalisé
      await next();
    },
  ],
  repos: {
    users: {
      path: "users",
      filterableFields: ["email", "status", "role"],
      orderableFields: ["createdAt", "name"],
      allowDelete: true,
    },
    posts: {
      path: "posts",
      allowedIncludes: ["userId"],
      allowDelete: false,
    },
  },
  openapi: {
    title: "Mon API CRUD",
    version: "1.0.0",
    description: "API RESTful propulsée par Firestore Repo Service",
  },
});
```

---

## Aperçu des endpoints

| Méthode | Endpoint | Description |
|---|---|---|
| `GET` | `/:repoName` | Lister les documents (paginé, avec filtres et `withTotal`) |
| `GET` | `/:repoName/:id` | Récupérer un document unique par son ID |
| `POST` | `/:repoName` | Créer un nouveau document (validé par Zod) |
| `PUT` | `/:repoName/:id` | Remplacer un document |
| `PATCH` | `/:repoName/:id` | Mettre à jour partiellement un document |
| `DELETE` | `/:repoName/:id` | Supprimer un document |
| `POST` | `/:repoName/query` | Requête avancée (conditions ET/OU, relations, décompte total) |
| `POST` | `/:repoName/batch` | Exécuter des opérations batch atomiques |
| `GET` | `/openapi.json` | Spécification JSON OpenAPI 3.1 |
| `GET` | `/docs` | Documentation interactive Scalar |

---

## Lister les documents (`GET /:repoName`)

Paramètres de requête :
- `pageSize`: Nombre d'éléments par page (défaut : 25, max : 100)
- `cursor`: Jeton de curseur Base64 pour la pagination
- `direction`: Sens de la pagination (`next` | `prev`)
- `orderBy`: Champ de tri
- `orderDir`: Sens du tri (`asc` | `desc`)
- `select`: Liste de champs séparés par des virgules à projeter
- `includes`: Liste de relations séparées par des virgules à populer
- `withTotal`: Définir à `true` pour demander le décompte total des documents correspondants
- Paramètres de filtre : `?field=value`, `?field__gt=10`, `?field__in=a,b`, `?field__containsAny=x,y`

**Exemple :**
`GET /api/users?status=active&pageSize=10&withTotal=true`

**Réponse :**
```json
{
  "success": true,
  "data": {
    "items": [ ... ],
    "nextCursor": "eyJ...",
    "prevCursor": null,
    "hasNextPage": true,
    "hasPrevPage": false,
    "totalCount": 142,
    "totalCountIsExact": true
  },
  "meta": {
    "pageSize": 10,
    "hasMore": true,
    "totalCount": 142,
    "totalCountIsExact": true
  }
}
```

---

## Requêtes avancées (`POST /:repoName/query`)

Envoyez des conditions de filtrage complexes incluant `where` (ET), `orWhere` (OU simple) et `orWhereGroups` (OU composé).

**Corps de la requête :**
```json
{
  "where": [["status", "==", "active"]],
  "orWhereGroups": [
    [["role", "==", "admin"], ["age", ">=", 18]],
    [["role", "==", "moderator"]]
  ],
  "orderBy": [{ "field": "createdAt", "direction": "desc" }],
  "pageSize": 10,
  "withTotal": true
}
```

**Comportement du décompte total (`withTotal`) :**
- **Requêtes ET pures & requêtes `in` découpées** : Agrégation serveur native `.count()`. `totalCountIsExact` vaut `true`.
- **Requêtes OU (`orWhere`, `orWhereGroups`)** : Agrégation serveur `.count()` exécutée en parallèle sur chaque branche du OU. Ultra rapide et économique (`1000 docs = 1 lecture d'index`). `totalCountIsExact` vaut `false` (décompte estimé suite au chevauchement possible des branches).

---

## Options de configuration (`CrudServerOptions`)

| Option | Type | Description |
|---|---|---|
| `basePath` | `string` | Préfixe du chemin d'accès (ex. `"/api/v1"`) |
| `middlewares` | `MiddlewareHandler[]` | Tableau de middlewares Hono personnalisés |
| `repos` | `Record<string, CrudRepoConfig>` | Configuration par repository |
| `indexesError` | `(err: { repoName, error, indexUrl, c }) => void` | Callback déclenché lors d'une erreur d'index manquant Firestore |
| `openapi` | `OpenAPISpecOptions` | Paramètres de documentation OpenAPI 3.1 |
| `verbose` | `boolean` | Afficher les détails des erreurs serveur lors d'un code HTTP 500 |

---

## Configuration par Repository (`CrudRepoConfig`)

| Option | Type | Description |
|---|---|---|
| `path` | `string` | Chemin de la collection Firestore |
| `filterableFields` | `string[]` | Liste des champs autorisés pour le filtrage |
| `orderableFields` | `string[]` | Liste des champs autorisés pour le tri |
| `allowedIncludes` | `string[]` | Liste des clés de relation autorisées dans `includes` |
| `allowDelete` | `boolean` | Activer ou non l'endpoint `DELETE /:id` |
| `rules` | `CrudRule[]` | Règles de validation préalables (Before Rules & Moteur de diff) |
| `pageSize` | `number` | Taille de page par défaut |

---

## Règles préalables & Moteur de diff (`rules`)

Vous pouvez définir des règles de validation métier exécutées avant toute mutation de document (`PUT`, `PATCH`, et `POST /:repoName/batch`). Chaque règle reçoit l'état du document avant mutation (`before`), l'état simulé après mutation (`after`), le dictionnaire des champs modifiés (`changes`), le type d'opération (`op`), l'ID du document ainsi que le contexte Hono (`c`).

```typescript
repos: {
  events: {
    path: "events",
    rules: [
      {
        description: "Impossible d'annuler un événement déjà facturé",
        run: ({ before, changes }) => {
          if (changes.status === "cancelled" && before.isInvoiced) {
            return false; // Rejette avec HTTP 403 et la description de la règle
          }
          return true;
        },
      },
      {
        description: "Seuls les administrateurs peuvent réassigner un événement",
        run: ({ changes, c }) => {
          if (changes.organizerId) {
            const user = c.get("user");
            if (user?.role !== "admin") return "Forbidden: Rôle admin requis";
          }
          return true;
        },
      },
    ],
  },
}
```

Si une règle retourne `false` ou un message d'erreur textuel, la mutation est bloquée et l'API répond avec une erreur `HTTP 403 Forbidden` sans écrire dans Firestore.

---

## Détection automatique d'index manquant (`indexesError` & HTTP 424)

Lorsqu'une requête filtrée ou complexe nécessite un index composite non créé dans Firestore, le serveur CRUD intercepte automatiquement l'erreur `FAILED_PRECONDITION` de Firestore :

1. **Appel du callback `indexesError`** : Transmet `{ repoName, error, indexUrl, c }` pour le logging, vos alertes ou Sentry.
2. **Réponse `HTTP 424 Failed Dependency`** : Inclut le lien direct vers la console Firebase pour créer l'index composite en un clic :

```json
{
  "success": false,
  "error": "The query requires a composite index.",
  "indexUrl": "https://console.firebase.google.com/v1/r/project/mon-projet/firestore/indexes?create_composite=..."
}
```

