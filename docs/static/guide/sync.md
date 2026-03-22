# Firestore → SQL Sync

Automatically replicate Firestore collections to a SQL database (BigQuery, etc.) via Cloud Pub/Sub.

## Architecture

```
Firestore Triggers → Cloud Pub/Sub → Worker → SQL Database
      (onCreate/onUpdate/onDelete)           (BigQuery, etc.)
```

Each document change in Firestore publishes a message to a per-repo Pub/Sub topic.
A worker subscribes to these topics, batches the changes, and flushes them to SQL.

## Quick Start

```typescript
import { createFirestoreSync } from "@lpdjs/firestore-repo-service/sync";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";
import { onRequest } from "firebase-functions/v2/https";

const sync = createFirestoreSync(repos, {
  deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "my-project" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  admin: {
    onRequest,
    httpsOptions: { invoker: "public" },
    auth: { type: "basic", username: "admin", password: "secret" },
    featuresFlag: {
      healthCheck: true,
      manualSync: true,
      viewQueue: true,
      configCheck: true,
    },
  },
  repos: {
    users: {
      exclude: ["sensitiveField"],
      columnMap: { docId: "user_id" },
      tableName: "users",
    },
    posts: { columnMap: { docId: "post_id" } },
  },
});

// Export triggers + PubSub handlers
export const {
  users_onCreate, users_onUpdate, users_onDelete, sync_users,
  posts_onCreate, posts_onUpdate, posts_onDelete, sync_posts,
  syncAdmin,
} = sync.functions;
```

## Configuration

### `createFirestoreSync(repos, config)`

The unified wrapper that creates triggers, workers, and the optional admin server.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `deps` | `SyncDeps` | required | Firebase Functions + PubSub dependencies |
| `adapter` | `SqlAdapter` | required | SQL adapter (e.g. `BigQueryAdapter`) |
| `topicPrefix` | `string` | `"firestore-sync"` | Pub/Sub topic name prefix |
| `batchSize` | `number` | `100` | Max rows per flush batch |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |
| `autoMigrate` | `boolean` | `false` | Auto-create/migrate tables on first event |
| `admin` | `SyncAdminConfig` | — | Optional admin endpoint config |
| `repos` | `TypedRepoSyncConfigs` | — | Per-repo overrides |

### Dependencies (`deps`)

All Firebase/GCP modules are injected — the library never imports them directly:

```typescript
deps: {
  firestoreTriggers, // firebase-functions/v2/firestore
  pubsubHandler,     // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

### Per-Repo Config (`repos`)

| Option | Type | Description |
|--------|------|-------------|
| `tableName` | `string` | SQL table name (defaults to repo name) |
| `exclude` | `string[]` | Fields to exclude from SQL |
| `columnMap` | `Record<string, string>` | Rename fields → SQL columns |
| `triggerPath` | `string` | **Required for collection groups** — the full document path pattern |

### Collection Groups (`triggerPath`)

For repos with `isGroup: true`, you **must** provide a `triggerPath`:

```typescript
repos: {
  comments: {
    triggerPath: "posts/{postId}/comments/{docId}",
    tableName: "comments",
  },
}
```

This tells Firebase where to listen for document changes since collection groups span multiple paths.

## BigQuery Adapter

```typescript
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { BigQuery } from "@google-cloud/bigquery";

const adapter = new BigQueryAdapter({
  bigquery: new BigQuery({ projectId: "my-project" }),
  datasetId: "firestore_sync",
});
```

The adapter handles:
- Table creation via DDL
- Streaming inserts
- MERGE-based upserts
- Delete by primary key
- Schema introspection (for health checks)

### Authentication

- **Production (Cloud Run / Cloud Functions)**: credentials are automatic via ADC — just pass `projectId`
- **Local development**: run `gcloud auth application-default login`

## Sync Admin

The optional admin endpoint provides a web UI for monitoring and managing the sync pipeline.

### Features

| Feature | Flag | Description |
|---------|------|-------------|
| **Health Check** | `healthCheck` | Compare expected schema (from Zod) vs actual SQL columns |
| **Force Sync** | `manualSync` | Re-sync all documents from a Firestore collection |
| **View Queues** | `viewQueue` | Inspect pending items in the per-repo queue |
| **Config Check** | `configCheck` | Verify GCP APIs, topics, tables, and IAM — with `gcloud` fix commands |

### Configuration

```typescript
admin: {
  auth: {
    type: "basic",
    realm: "Sync Admin",
    username: "admin",
    password: process.env.SYNC_ADMIN_PASSWORD!,
  },
  basePath: "/",
  featuresFlag: {
    healthCheck: true,
    manualSync: true,
    viewQueue: true,
    configCheck: true,
  },
}
```

### Authentication

Same as the Admin Server — supports HTTP Basic Auth or a custom middleware function:

```typescript
// Custom middleware
admin: {
  auth: async (req, res, next) => {
    const token = req.headers["x-api-key"];
    if (token !== process.env.API_KEY) {
      res.status(401).send("Unauthorized");
      return;
    }
    next();
  },
}
```

### Config Check

The `/config-check` endpoint verifies your GCP setup:

- **BigQuery API** — is it enabled and accessible?
- **BigQuery tables** — does each repo table exist?
- **Pub/Sub topics** — does each `{topicPrefix}-{repoName}` topic exist?

For each issue, it shows:
- A `gcloud` command to fix it
- A direct link to the GCP Console

Supports `Accept: application/json` for programmatic use.

### Deploying the Admin

The admin handler is auto-wrapped when `onRequest` is provided in the config.
Pass `httpsOptions` to configure the Cloud Function (invoker, memory, region, etc.):

```typescript
admin: {
  onRequest,
  httpsOptions: { invoker: "public", memory: "512MiB" },
  auth: { type: "basic", username: "admin", password: "secret" },
  featuresFlag: { healthCheck: true, configCheck: true },
}
```

The handler is then available in `sync.functions.syncAdmin` — already wrapped as a Cloud Function.

If you omit `onRequest`, the raw handler is exposed and you wrap it manually:

```typescript
import { onRequest } from "firebase-functions/v2/https";

export const syncAdmin = onRequest(
  { invoker: "public" },
  sync.adminHandler!,
);
```

## Generated Functions

`createFirestoreSync` generates these Cloud Functions:

| Function | Type | Purpose |
|----------|------|---------|
| `{repo}_onCreate` | Firestore trigger | Publish UPSERT on document create |
| `{repo}_onUpdate` | Firestore trigger | Publish UPSERT on document update |
| `{repo}_onDelete` | Firestore trigger | Publish DELETE on document delete |
| `sync_{repo}` | PubSub handler | Process messages and flush to SQL |
| `syncAdmin` | HTTP handler | Admin UI (if `admin` config provided) |

## Schema Mapping

Zod schemas are automatically mapped to SQL types:

| Zod Type | BigQuery Type |
|----------|--------------|
| `z.string()` | `STRING` |
| `z.number()` | `FLOAT64` |
| `z.bigint()` | `INT64` |
| `z.boolean()` | `BOOL` |
| `z.date()` | `TIMESTAMP` |
| `z.object()` / `z.array()` | `JSON` |

## Custom SQL Adapter

Implement the `SqlAdapter` interface for other databases:

```typescript
import type { SqlAdapter, SqlDialect, SqlColumn, SqlTableDef } from "@lpdjs/firestore-repo-service/sync";

class MyAdapter implements SqlAdapter {
  get dialect(): SqlDialect { /* ... */ }
  async tableExists(tableName: string): Promise<boolean> { /* ... */ }
  async getTableColumns(tableName: string): Promise<string[]> { /* ... */ }
  async createTable(table: SqlTableDef): Promise<void> { /* ... */ }
  async insertRows(tableName: string, rows: Record<string, unknown>[]): Promise<void> { /* ... */ }
  async upsertRows(tableName: string, rows: Record<string, unknown>[], primaryKey: string): Promise<void> { /* ... */ }
  async deleteRows(tableName: string, primaryKey: string, ids: string[]): Promise<void> { /* ... */ }
  async executeRaw(sql: string): Promise<void> { /* ... */ }
}
```
