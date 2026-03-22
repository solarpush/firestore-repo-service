# Serveur Admin

`createAdminServer` génère une interface admin zéro-JS servie depuis une Firebase HTTPS Function.

**Fonctionnalités :**
- Dashboard listant tous les repositories
- Liste de documents avec pagination curseur, colonnes triables, sélecteur de lignes par page
- Barre de filtres générée depuis `fieldsConfig` (champs avec le rôle `"filterable"`)
- Formulaires création / édition générés depuis le schéma Zod
- Colonnes d'action relationnelles (naviguer vers le repo lié)
- Authentification HTTP Basic ou middleware custom

## Configuration de base

```typescript
import { onRequest } from "firebase-functions/https";
import { createAdminServer } from "@lpdjs/firestore-repo-service/servers/admin";

const adminHandler = createAdminServer({
    httpsOptions: { invoker: "public" },
    basePath: "/admin",
    auth: {
      type:     "basic",
      realm:    "Admin",
      username: "admin",
      password: process.env.ADMIN_PASSWORD!,
    },
    repos: {
      users: {
        repo: repos.users,
        path: "users",
        fieldsConfig: {
          name:     ["create", "mutable", "filterable"],
          email:    ["create", "mutable", "filterable"],
          age:      ["create", "mutable", "filterable"],
          isActive: ["create", "mutable", "filterable"],
          docId:    ["filterable"],
        },
        allowDelete: true,
      },
      posts: {
        repo: repos.posts,
        path: "posts",
        fieldsConfig: {
          title:   ["create", "mutable"],
          content: ["create", "mutable"],
          status:  ["create", "mutable", "filterable"],
          userId:  ["create", "filterable"],
        },
        relationalFields: [
          { key: "userId", column: "Auteur" },
        ],
        allowDelete: false,
      },
    },
  });

export const admin = onRequest(adminHandler.httpsOptions!, adminHandler);
```

## Options AdminRepoConfig

| Champ                | Type                             | Défaut    | Description                                             |
|----------------------|----------------------------------|-----------|---------------------------------------------------------|
| `repo`               | `ConfiguredRepository`           | requis    | Instance du repository                                  |
| `path`               | `string`                         | requis    | Chemin affiché dans l'UI                                |
| `schema`             | `ZodObject`                      | auto      | Schéma Zod (auto-détecté avec `createRepositoryConfig(schema)`) |
| `documentKey`        | `string`                         | `"docId"` | Champ utilisé comme ID de document                      |
| `listColumns`        | `string[]`                       | all keys  | Colonnes affichées dans la liste                        |
| `pageSize`           | `number`                         | `25`      | Nombre de lignes par page par défaut                    |
| `fieldsConfig`       | `Record<FieldPath, FieldRole[]>` | all keys  | Config par champ : `"create"`, `"mutable"`, `"filterable"` |
| `allowDelete`        | `boolean`                        | `false`   | Afficher le bouton Supprimer                            |
| `relationalFields`   | `{ key, column }[]`              | aucun     | Colonnes boutons relationnelles                         |

## Champs en dot-notation

```typescript
fieldsConfig: {
  status:           ["filterable"],
  "address.city":   ["create", "mutable", "filterable"],
  "address.street": ["create", "mutable", "filterable"],
  title:            ["create", "mutable"],
}
```

## Champs relationnels

```typescript
// Sur posts : bouton "Auteur" → /users?fv_docId=<post.userId>
relationalFields: [{ key: "userId", column: "Auteur" }]

// Sur users : bouton "Posts" → /posts?fv_userId=<user.docId>
relationalFields: [{ key: "docId", column: "Posts" }]
```

## Contrôles de pagination

- **Navigation curseur** : ← Précédent / Suivant →
- **Lignes par page** : [10] [25] [50] [100] (querystring `?ps=N`)
- **Tri par colonne** : clic sur l'en-tête (querystring `?ob=champ&od=asc|desc`)
- **Filtres** : persistés à travers la pagination

## Authentification

### HTTP Basic Auth

```typescript
auth: { type: "basic", realm: "Zone Admin", username: "admin", password: "secret" }
```

### Middleware custom

```typescript
auth: async (req, res, next) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    res.status(401).send("Non autorisé");
    return;
  }
  next();
}
```

## Firebase HttpsOptions

Passez n'importe quelle option `HttpsOptions` (invoker, region, memory, etc.) via `httpsOptions`.
Les options sont attachées au handler retourné pour un usage facile avec `onRequest()` :

```typescript
const handler = createAdminServer({
  httpsOptions: { invoker: "public", memory: "512MiB" },
  // ...
});

export const admin = onRequest(handler.httpsOptions!, handler);
```

Options disponibles : `invoker`, `region`, `memory`, `timeoutSeconds`, `minInstances`,
`maxInstances`, `concurrency`, `cors`, `serviceAccount`, `secrets`, etc.

## Serveur de pagination API

```typescript
import { createPaginationFunction } from "@lpdjs/firestore-repo-service/servers/pagination";
import z from "zod";

export const postsApi = onRequest(
  createPaginationFunction(repos.posts, {
    schema:          z.object({ status: z.enum(["draft", "published"]).optional() }),
    defaultPageSize: 20,
    maxPageSize:     100,
    cors:            true,
  }),
);
```
