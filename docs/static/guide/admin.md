# Admin Server

The admin UI is built via `createServers(repos).admin(...)` — a unified factory that auto-binds the repository registry so each entry's `repo` field is inferred from its key (and so are model field paths in `fieldsConfig`).

**Features:**
- Dashboard listing all repositories
- Document list with cursor-based pagination, sortable columns, rows-per-page selector
- Filter bar generated from `fieldsConfig` (fields with `"filterable"` role)
- Create / Edit forms generated from Zod schemas
- Relational action columns (navigate to related repo)
- HTTP Basic Auth or custom middleware guard
- Zero JavaScript framework — DaisyUI + plain HTML

## Basic setup

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
    type: "basic",
    realm: "Admin",
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
        { key: "userId", column: "Author" },   // button → /users?fv_docId=<value>
      ],
      allowDelete: false,
    },
  },
});
```

When `onRequest` is passed to `createServers`, `servers.admin()` returns a ready-to-export Cloud Function. Without it, it returns a raw HTTP handler that you can wrap yourself (its `.httpsOptions` are forwarded for convenience).

## AdminRepoConfig options

| Field                | Type                             | Default   | Description                                         |
|----------------------|----------------------------------|-----------|-----------------------------------------------------|
| `path`               | `string`                         | required  | Display path in the UI                              |
| `schema`             | `ZodObject`                      | auto      | Zod schema (auto-detected when using `createRepositoryConfig(schema)`) |
| `documentKey`        | `string`                         | `"docId"` | Field used as document ID                           |
| `listColumns`        | `string[]`                       | all keys  | Columns shown in the list view                      |
| `pageSize`           | `number`                         | `25`      | Default rows per page                               |
| `fieldsConfig`       | `Record<FieldPath, FieldRole[]>` | all keys  | Per-field role config: `"create"`, `"mutable"`, `"filterable"` |
| `allowDelete`        | `boolean`                        | `false`   | Show Delete button in the list                      |
| `relationalFields`   | `{ key, column }[]`              | none      | Relational action button columns                    |

> The `repo` field is **not** part of `AdminRepoConfig` anymore — it is automatically injected from the registry key (e.g. `posts:` → `repos.posts`).

## fieldsConfig with dot-notation

Fields support dot-notation for nested Zod objects:

```typescript
fieldsConfig: {
  status:           ["filterable"],
  "address.city":   ["create", "mutable", "filterable"],
  "address.street": ["create", "mutable", "filterable"],
  title:            ["create", "mutable"],
}
```

The filter bar builds the correct Firestore path (`address.city`) automatically.

## Relational fields

Each entry adds a dedicated button column in the list view.
The button navigates to the linked repository filtered by the field value.

```typescript
// On the posts repo: "Author" button goes to /users?fv_docId=<post.userId>
relationalFields: [{ key: "userId", column: "Author" }]

// On the users repo: "Posts" button goes to /posts?fv_userId=<user.docId>
relationalFields: [{ key: "docId", column: "Posts" }]
```

Relations are resolved automatically from `buildRepositoryRelations` — no extra config needed.

## Pagination controls

The list view supports:
- **Cursor navigation**: ← Previous / Next → buttons (cursor-based, correct prev/next detection)
- **Rows per page**: [10] [25] [50] [100] selector (querystring `?ps=N`)
- **Column sort**: click any column header to sort asc → desc → default (querystring `?ob=field&od=asc|desc`)
- **Filters**: persist across pagination and sort changes

## Authentication

### HTTP Basic Auth

```typescript
auth: {
  type:     "basic",
  realm:    "Admin Area",
  username: "admin",
  password: "secret",
}
```

### Custom middleware

```typescript
auth: async (req, res, next) => {
  const token = req.headers["x-api-key"];
  if (token !== process.env.API_KEY) {
    res.status(401).send("Unauthorized");
    return;
  }
  next();
}
```

### Additional middleware

```typescript
createServers(repos).admin({
  middleware: [
    (req, res, next) => {
      console.log(req.method, req.url);
      next();
    },
  ],
  // ...
})
```

## Firebase HttpsOptions

Pass any `HttpsOptions` (invoker, region, memory, etc.) at the `createServers` level (applied to every server) or per-server. When `onRequest` is provided to `createServers`, the returned value is already a ready-to-deploy Cloud Function:

```typescript
const servers = createServers(repos, {
  onRequest,
  httpsOptions: { invoker: "public", memory: "512MiB" },
});

export const admin = servers.admin({ /* ... */ });
```

If you don't pass `onRequest`, you get the raw handler back (its `.httpsOptions` are still attached for convenience):

```typescript
const handler = createServers(repos).admin({
  httpsOptions: { invoker: "public", memory: "512MiB" },
  // ...
});

export const admin = onRequest(handler.httpsOptions!, handler);
```

Available options include `invoker`, `region`, `memory`, `timeoutSeconds`, `minInstances`,
`maxInstances`, `concurrency`, `cors`, `serviceAccount`, `secrets`, etc.

## Composite Index Error Handling

When a query requires a composite index that doesn't exist, Firestore throws `FAILED_PRECONDITION` (code 9).
The admin server catches this error and displays a helpful alert with a direct link to create the index:

- **Regular collections**: the error message often contains the Firebase Console URL — the admin extracts it automatically
- **Collection groups**: Firestore does *not* include the URL — the admin **generates** it from the query context (filters, sort, collection ID, project ID)

The list view shows a **warning alert** with a "Create Index →" button linking directly to the Firebase Console index creation wizard.

### Filter bar index hint

When two or more filters are active (or any filter on a collection group), the filter bar displays a subtle info badge:

> ⚠ This query may require a composite index.

This proactive hint helps before the query even fails.

### `QueryError` type

```typescript
interface QueryError {
  type: "index" | "error";
  message: string;
  indexUrl?: string;  // Firebase Console URL (always present for "index" type)
}
```

## CRUD API Server

For client-facing REST endpoints with validation, pagination, and relation population, use `createServers(repos).crud(...)`:

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

### Firebase Auth (cookie session for admin, bearer for CRUD)

A built-in helper wires Firebase Authentication into both `servers.admin()` and `servers.crud()`:

```typescript
import { firebaseAuth } from "@lpdjs/firestore-repo-service/servers/auth";
import { getAuth } from "firebase-admin/auth";

// Admin: cookie session + auto-mounted /__login page
auth: firebaseAuth({
  getAuth,
  mode: "cookie",                             // default for admin
  allow: (u) => {
    const role = u.claims.role as string | undefined;
    if (role === "superAdmin" || role === "admin" || role === "viewer") {
      return { role };                        // becomes req.user.context
    }
    return null;                              // → 302 to /__login
  },
})
```

Modes:

- `"cookie"` — auto-mounts `GET /__login`, `POST /__session`, `POST /__logout`. Uses HttpOnly cookies. Best for browser admin UIs.
- `"bearer"` — verifies `Authorization: Bearer <idToken>`. Best for REST/CRUD APIs.
- `"both"` — accepts either; useful for hybrid backends.

The `allow()` callback maps a verified Firebase user to your business context (returning `null` rejects). Whatever it returns becomes `req.user.context` inside handlers and rules.

::: tip Auth emulator
The Admin SDK already targets the Auth emulator when `FIREBASE_AUTH_EMULATOR_HOST` is set. The bundled login page now follows suit: pass `authEmulatorHost` (defaults to that same env var) and its client SDK is wired with `connectAuthEmulator`, so local `firebase emulators:start` sign-ins work end-to-end. Pass `authEmulatorHost: ""` to force production even under the emulator. This applies to `servers.admin()`, `servers.crud()` and the sync admin alike.

**Non-`us-central1` region?** Under the emulator the region isn't reliably exposed, so the login page's same-function URLs fall back to `us-central1` — making the session POST 404 when you deploy elsewhere. Pass your region to `firebaseAuth({ region: "europe-west1", ... })` so the login/session prefix is correct. (The rest of the admin UI links pick the region up automatically from `httpsOptions.region`.)
:::

## Per-repo authorization rules (CRUD)

When `auth` is set on `servers.crud()`, each repo follows a **default-deny** policy: any operation without an explicit `rules.<op>` returns `403`. Use `allowAll` or `() => true` to explicitly open one.

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
        // Row-level filter applied to every doc returned by list/query/get
        filter: ({ user, doc })  =>
          doc.public || doc.authorId === user.uid,
      },
    },
  },
});
```

Each rule receives a typed context (`user`, plus `doc` / `body` / `query` / `params` depending on the op) and returns `boolean | Promise<boolean>`. Rules are intentionally **per-repo** so each collection can use its own business roles, independent from any admin RBAC trio.

