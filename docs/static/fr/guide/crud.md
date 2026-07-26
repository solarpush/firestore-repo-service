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
| `pageSize` | `number` | Taille de page par défaut |
