# CRUD Server

The CRUD REST API server is built via `createServers(repos).crud(...)` — a unified factory that exposes standard RESTful endpoints and advanced query APIs for all registered repositories.

**Features:**
- Auto-generated REST endpoints (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
- Advanced query endpoint (`POST /:repoName/query`) with `where`, `orWhere`, `orWhereGroups`, and `includes`
- Atomic batch endpoint (`POST /:repoName/batch`)
- Server-side total counting (`withTotal`) powered by Firestore `.count()` aggregation
- Automatic OpenAPI 3.1 spec (`/openapi.json`) and Scalar documentation UI (`/docs`)
- Zod schema validation for input payloads
- Hono middleware support (Auth, logging, CORS, rate-limiting)

---

## Basic setup

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
      // Custom auth / middleware logic
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
    title: "My CRUD API",
    version: "1.0.0",
    description: "RESTful API powered by Firestore Repo Service",
  },
});
```

---

## Endpoints overview

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/:repoName` | List documents (paginated, with query filters and `withTotal`) |
| `GET` | `/:repoName/:id` | Get single document by ID |
| `POST` | `/:repoName` | Create a new document (Zod validated) |
| `PUT` | `/:repoName/:id` | Replace document |
| `PATCH` | `/:repoName/:id` | Partial update document |
| `DELETE` | `/:repoName/:id` | Delete document |
| `POST` | `/:repoName/query` | Advanced query (AND, OR groups, includes, total count) |
| `POST` | `/:repoName/batch` | Execute atomic batch write operations |
| `GET` | `/openapi.json` | OpenAPI 3.1 JSON specification |
| `GET` | `/docs` | Interactive Scalar API documentation |

---

## Listing documents (`GET /:repoName`)

Query parameters:
- `pageSize`: Number of items per page (default: 25, max: 100)
- `cursor`: Base64 cursor token for pagination
- `direction`: Pagination direction (`next` | `prev`)
- `orderBy`: Field to sort by
- `orderDir`: Sort direction (`asc` | `desc`)
- `select`: Comma-separated list of fields to project
- `includes`: Comma-separated list of relations to populate
- `withTotal`: Set to `true` to request total matching document count
- Filter params: `?field=value`, `?field__gt=10`, `?field__in=a,b`, `?field__containsAny=x,y`

**Example:**
`GET /api/users?status=active&pageSize=10&withTotal=true`

**Response:**
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

## Advanced query (`POST /:repoName/query`)

Send complex filter conditions including `where` (AND), `orWhere` (simple OR), and `orWhereGroups` (compound OR).

**Request Body:**
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

**Total Count Behavior (`withTotal`):**
- **Pure AND queries & split `in` clauses**: Uses server-side `.count()` aggregation. `totalCountIsExact` is `true`.
- **OR queries (`orWhere`, `orWhereGroups`)**: Executes parallel server-side `.count()` queries across OR branches. Fast and lightweight (`1000 docs = 1 index read`). `totalCountIsExact` is `false` (estimated due to potential branch overlap).

---

## Configuration options (`CrudServerOptions`)

| Option | Type | Description |
|---|---|---|
| `basePath` | `string` | Base path prefix (e.g., `"/api/v1"`) |
| `middlewares` | `MiddlewareHandler[]` | Custom Hono middleware array |
| `repos` | `Record<string, CrudRepoConfig>` | Per-repository configuration mapping |
| `openapi` | `OpenAPISpecOptions` | OpenAPI 3.1 documentation settings |
| `verbose` | `boolean` | Include detailed error messages in HTTP 500 responses |

---

## Per-Repository Configuration (`CrudRepoConfig`)

| Option | Type | Description |
|---|---|---|
| `path` | `string` | Collection path |
| `filterableFields` | `string[]` | List of allowed fields for filtering |
| `orderableFields` | `string[]` | List of allowed fields for ordering |
| `allowedIncludes` | `string[]` | List of relation keys allowed in `includes` |
| `allowDelete` | `boolean` | Whether `DELETE /:id` is enabled |
| `pageSize` | `number` | Default page size for list requests |
