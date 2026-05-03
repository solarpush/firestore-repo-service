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

For client-facing REST endpoints with validation, pagination, and relation population, use `createCrudServer`:

```typescript
import { createCrudServer } from "@lpdjs/firestore-repo-service/servers/crud";

export const api = onRequest(
  createCrudServer({
    basePath: "/api",
    repos: {
      posts: {
        repo: repos.posts,
        schema: postSchema,
        path: "posts",
        fieldsConfig: {
          status:   ["filterable"],
          authorId: ["filterable"],
        },
        allowDelete: true,
      },
    },
  }),
);
```

Supports GET and POST with `where`, `orderBy`, `select`, `include`, `cursor`, and `pageSize`.
