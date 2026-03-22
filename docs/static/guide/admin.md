# Admin Server

`createAdminServer` generates a zero-JS admin UI served as a Firebase HTTPS function.

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
import { createAdminServer } from "@lpdjs/firestore-repo-service/servers/admin";

const adminHandler = createAdminServer({
    httpsOptions: { invoker: "public" },
    basePath: "/admin",
    auth: {
      type: "basic",
      realm: "Admin",
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
          { key: "userId", column: "Author" },   // button → /users?fv_docId=<value>
        ],
        allowDelete: false,
      },
    },
  });

export const admin = onRequest(adminHandler.httpsOptions!, adminHandler);
```

## AdminRepoConfig options

| Field                | Type                             | Default   | Description                                         |
|----------------------|----------------------------------|-----------|-----------------------------------------------------|
| `repo`               | `ConfiguredRepository`           | required  | The repository instance                             |
| `path`               | `string`                         | required  | Display path in the UI                              |
| `schema`             | `ZodObject`                      | auto      | Zod schema (auto-detected when using `createRepositoryConfig(schema)`) |
| `documentKey`        | `string`                         | `"docId"` | Field used as document ID                           |
| `listColumns`        | `string[]`                       | all keys  | Columns shown in the list view                      |
| `pageSize`           | `number`                         | `25`      | Default rows per page                               |
| `fieldsConfig`       | `Record<FieldPath, FieldRole[]>` | all keys  | Per-field role config: `"create"`, `"mutable"`, `"filterable"` |
| `allowDelete`        | `boolean`                        | `false`   | Show Delete button in the list                      |
| `relationalFields`   | `{ key, column }[]`              | none      | Relational action button columns                    |

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
createAdminServer({
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

Pass any `HttpsOptions` (invoker, region, memory, etc.) through `httpsOptions`.
The options are attached to the returned handler for easy forwarding to `onRequest()`:

```typescript
const handler = createAdminServer({
  httpsOptions: { invoker: "public", memory: "512MiB" },
  // ...
});

// Forward options to onRequest
export const admin = onRequest(handler.httpsOptions!, handler);
```

Available options include `invoker`, `region`, `memory`, `timeoutSeconds`, `minInstances`,
`maxInstances`, `concurrency`, `cors`, `serviceAccount`, `secrets`, etc.

## Pagination API server (`createPaginationFunction`)

A separate Firebase HTTPS handler for client-facing paginated API endpoints:

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

Supports GET (query string) and POST (JSON body) with `where`, `orderBy`, `select`,
`include`, `cursor` (base64url encoded), and `pageSize`.
