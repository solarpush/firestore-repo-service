# Serveur Admin

L'UI admin se construit via `createServers(repos).admin(...)` — une fabrique unifiée qui auto-injecte le repository depuis la clé du registre (et infère ainsi les chemins de champs typés dans `fieldsConfig`).

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
import { createServers } from "@lpdjs/firestore-repo-service";

const servers = createServers(repos, {
  onRequest,
  httpsOptions: { invoker: "public" },
});

export const admin = servers.admin({
  basePath: "/admin",
  auth: {
    type:     "basic",
    realm:    "Admin",
    username: "admin",
    password: process.env.ADMIN_PASSWORD!,
  },
  repos: {
    users: {
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
```

Lorsque `onRequest` est passé à `createServers`, `servers.admin()` retourne directement une Cloud Function prête à exporter. Sinon, vous récupérez un handler HTTP brut (avec ses `.httpsOptions` attachées) que vous pouvez wrapper vous-même.

## Options AdminRepoConfig

| Champ                | Type                             | Défaut    | Description                                             |
|----------------------|----------------------------------|-----------|---------------------------------------------------------|
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

Passez n'importe quelle option `HttpsOptions` (invoker, region, memory, etc.) au niveau de `createServers` (appliquée à tous les serveurs) ou par serveur. Quand `onRequest` est fourni à `createServers`, la valeur retournée est déjà une Cloud Function prête à déployer :

```typescript
const servers = createServers(repos, {
  onRequest,
  httpsOptions: { invoker: "public", memory: "512MiB" },
});

export const admin = servers.admin({ /* ... */ });
```

Sans `onRequest`, vous récupérez le handler brut (`.httpsOptions` reste attaché) :

```typescript
const handler = createServers(repos).admin({
  httpsOptions: { invoker: "public", memory: "512MiB" },
  // ...
});

export const admin = onRequest(handler.httpsOptions!, handler);
```

## Gestion des erreurs d'index composite

Lorsqu'une requête nécessite un index composite qui n'existe pas, Firestore lance `FAILED_PRECONDITION` (code 9).
Le serveur admin intercepte cette erreur et affiche une alerte avec un lien direct pour créer l'index :

- **Collections classiques** : le message d'erreur contient souvent l'URL de la Console Firebase — l'admin l'extrait automatiquement
- **Collection groups** : Firestore n'inclut *pas* l'URL — l'admin la **génère** à partir du contexte de la requête (filtres, tri, collection ID, project ID)

La vue liste affiche une **alerte warning** avec un bouton "Créer l'index →" qui redirige vers l'assistant de création d'index de la Console Firebase.

### Indicateur dans la barre de filtres

Quand deux filtres ou plus sont actifs (ou n'importe quel filtre sur un collection group), la barre de filtres affiche un badge info :

> ⚠ Cette requête peut nécessiter un index composite.

Cet indicateur proactif aide avant même que la requête échoue.

### Type `QueryError`

```typescript
interface QueryError {
  type: "index" | "error";
  message: string;
  indexUrl?: string;  // URL Console Firebase (toujours présent pour le type "index")
}
```

## Serveur CRUD API

Pour des endpoints REST client avec validation, pagination et population de relations, utilisez `createServers(repos).crud(...)` :

```typescript
const servers = createServers(repos, { onRequest });

export const api = servers.crud({
  basePath: "/api",
  repos: {
    posts: {
      schema: postSchema,
      path: "posts",
      fieldsConfig: {
        status:   ["filterable"],
        authorId: ["filterable"],
      },
      allowDelete: true,
    },
  },
});
```

Supporte GET et POST avec `where`, `orderBy`, `select`, `include`, `cursor` et `pageSize`.

### Firebase Auth (cookie pour l'admin, bearer pour le CRUD)

Un helper intégré branche Firebase Authentication sur `servers.admin()` et `servers.crud()` :

```typescript
import { firebaseAuth } from "@lpdjs/firestore-repo-service/servers/auth";
import { getAuth } from "firebase-admin/auth";

// Admin : session cookie + page /__login auto-montée
auth: firebaseAuth({
  getAuth,
  mode: "cookie",                             // défaut pour l'admin
  allow: (u) => {
    const role = u.claims.role as string | undefined;
    if (role === "superAdmin" || role === "admin" || role === "viewer") {
      return { role };                        // devient req.user.context
    }
    return null;                              // → 302 vers /__login
  },
})
```

Modes :

- `"cookie"` — monte automatiquement `GET /__login`, `POST /__session`, `POST /__logout`. Cookies HttpOnly. Idéal pour les UIs admin navigateur.
- `"bearer"` — vérifie `Authorization: Bearer <idToken>`. Idéal pour les APIs REST/CRUD.
- `"both"` — accepte les deux ; utile pour les backends hybrides.

Le callback `allow()` mappe un utilisateur Firebase vérifié vers votre contexte métier (retourner `null` rejette). Sa valeur de retour devient `req.user.context` dans les handlers et les règles.

::: tip Émulateur Auth
L'Admin SDK cible déjà l'émulateur Auth quand `FIREBASE_AUTH_EMULATOR_HOST` est défini. La page de login fait désormais de même : passe `authEmulatorHost` (par défaut cette même variable d'env) et son SDK client est câblé via `connectAuthEmulator`, pour que les connexions locales `firebase emulators:start` marchent de bout en bout. Passe `authEmulatorHost: ""` pour forcer la prod même sous l'émulateur. Vaut pour `servers.admin()`, `servers.crud()` et l'admin de sync.
:::

## Règles d'autorisation par repo (CRUD)

Quand `auth` est défini sur `servers.crud()`, chaque repo suit une politique de **default-deny** : toute opération sans `rules.<op>` explicite renvoie `403`. Utilisez `allowAll` ou `() => true` pour ouvrir explicitement une opération.

```typescript
import { firebaseAuth, allowAll } from "@lpdjs/firestore-repo-service/servers/auth";

export const api = servers.crud({
  auth: firebaseAuth({ getAuth, mode: "bearer" }),
  repos: {
    comments: {
      path: "comments",
      allowDelete: true,
      rules: {
        list:   allowAll,
        get:    allowAll,
        create: ({ user })       => !!user.uid,
        update: ({ user, doc })  => doc.authorId === user.uid,
        delete: ({ user, doc })  =>
          doc.authorId === user.uid || user.context?.role === "moderator",
        // Filtre row-level appliqué à chaque doc retourné par list/query/get
        filter: ({ user, doc })  =>
          doc.public || doc.authorId === user.uid,
      },
    },
  },
});
```

Chaque règle reçoit un contexte typé (`user`, plus `doc` / `body` / `query` / `params` selon l'opération) et retourne `boolean | Promise<boolean>`. Les règles sont volontairement **par repo** : chaque collection peut utiliser ses propres rôles métier, indépendamment d'un éventuel trio RBAC admin.
