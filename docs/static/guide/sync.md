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
    bigquery: new BigQuery({ projectId: "my-project", location: "us-central1" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  ordering: true, // strict per-document ordering on Pub/Sub
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
    pubsubSetup: { ordering: true },
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
  users_onCreate,
  users_onUpdate,
  users_onDelete,
  sync_users,
  posts_onCreate,
  posts_onUpdate,
  posts_onDelete,
  sync_posts,
  adminsync,
} = sync.functions;
```

## Configuration

### `createFirestoreSync(repos, config)`

The unified wrapper that creates triggers, workers, and the optional admin server.

| Option            | Type                                                  | Default            | Description                                                       |
| ----------------- | ----------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `deps`            | `SyncDeps`                                            | required           | Firebase Functions + PubSub dependencies                          |
| `adapter`         | `SqlAdapter`                                          | required           | SQL adapter (e.g. `BigQueryAdapter`)                              |
| `topicPrefix`     | `string`                                              | `"firestore-sync"` | Pub/Sub topic name prefix                                         |
| `batchSize`       | `number`                                              | `100`              | Max rows per flush batch                                          |
| `flushIntervalMs` | `number`                                              | `5000`             | Flush interval in ms                                              |
| `autoMigrate`     | `boolean`                                             | `false`            | Auto-create/migrate tables on first event                         |
| `ordering`        | `boolean \| (event) => string`                        | `false`            | Enable Pub/Sub message ordering (per-`docId` when `true`)         |
| `admin`           | `adminsyncConfig`                                     | —                  | Optional admin endpoint config                                    |
| `repos`           | `TypedRepoSyncConfigs`                                | —                  | Per-repo overrides                                                |

### Dependencies (`deps`)

All Firebase/GCP modules are injected — the library never imports them directly:

```typescript
deps: {
  firestoreTriggers, // firebase-functions/v2/firestore
  pubsubHandler,     // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

::: tip Lazy initialization
`deps.pubsub` and `adapter` both accept a factory function `() => T` for lazy initialization.
This avoids creating gRPC channels or BigQuery connections at module-load time for Cloud Functions
that don't need them (e.g. HTTP-only functions sharing the same deploy).

```typescript
deps: { firestoreTriggers, pubsubHandler, pubsub: () => new PubSub() },
adapter: () => new BigQueryAdapter({ bigquery: new BigQuery(), datasetId: "sync" }),
```
:::

### Per-Repo Config (`repos`)

| Option        | Type                     | Description                                                         |
| ------------- | ------------------------ | ------------------------------------------------------------------- |
| `tableName`   | `string`                 | SQL table name (defaults to repo name)                              |
| `exclude`     | `string[]`               | Fields to exclude from SQL                                          |
| `columnMap`   | `Record<string, string>` | Rename fields → SQL columns                                         |
| `triggerPath` | `string`                 | **Required for collection groups** — the full document path pattern |

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

## Pub/Sub Message Ordering

By default, Pub/Sub does not guarantee message order. For Firestore sync this means rapid
successive writes to the same document (e.g. `create` then `update`) can be flushed to SQL
out of order, leaving stale data.

Pass `ordering: true` to publish each message with the document id as the **ordering key**.
The Pub/Sub broker then delivers messages with the same key sequentially to the worker.

```typescript
const sync = createFirestoreSync(repos, {
  // ...
  ordering: true, // per-docId ordering (recommended)
  // ordering: (event) => `${event.repo}:${event.docId}`, // custom key
});
```

::: warning Subscription must be created with `enableMessageOrdering: true`
The flag is **immutable** on a Pub/Sub subscription after creation. Cloud Functions v2
auto-creates subscriptions **without** ordering enabled, so you must pre-create them
before `firebase deploy` (or delete + recreate them). Use the `ensureSyncInfra` helper
below or the **Setup Pub/Sub** button on the admin Config Check page.
:::

On publish errors the publisher automatically calls `resumePublishing(orderingKey)` —
without that, all subsequent messages for the same key would be silently dropped.

## Pre-creating Topics & Subscriptions (`ensureSyncInfra`)

Helper that idempotently creates the Pub/Sub topics and push subscriptions used by the
sync pipeline, with the correct `enableMessageOrdering` flag.

```typescript
import { ensureSyncInfra } from "@lpdjs/firestore-repo-service/sync";
import { PubSub } from "@google-cloud/pubsub";

await ensureSyncInfra(repoMapping, {
  pubsub: new PubSub(),
  topicPrefix: "firestore-sync",
  ordering: true,
  subscriptionSuffix: "-sub",
  includeDLQ: true,
  ackDeadlineSeconds: 60,
  messageRetentionDuration: 7 * 24 * 60 * 60, // 7 days
});
```

| Option                     | Type      | Default        | Description                                           |
| -------------------------- | --------- | -------------- | ----------------------------------------------------- |
| `pubsub`                   | `PubSub`  | required       | Google Cloud Pub/Sub client                           |
| `topicPrefix`              | `string`  | required       | Same value as in `createFirestoreSync`                |
| `ordering`                 | `boolean` | `false`        | Create topics/subscriptions with ordering enabled     |
| `subscriptionSuffix`       | `string`  | `"-sub"`       | Subscription name suffix per topic                    |
| `includeDLQ`               | `boolean` | `false`        | Also create `{topic}-dlq` topics                      |
| `ackDeadlineSeconds`       | `number`  | provider-default | Subscription ack deadline                          |
| `messageRetentionDuration` | `number`  | provider-default | Retention in seconds                               |

Existing topics and subscriptions are left untouched (the result reports `created` /
`existing` counts). When ordering is enabled but an existing subscription was created
without it, a warning is emitted — you must delete and recreate that subscription.

### Wired into the admin dashboard (`pubsubSetup`)

When `pubsubSetup` is set under `admin`, a **⚙ Setup Pub/Sub** button appears on the
`/config-check` page (gated by `featuresFlag.configCheck`). Clicking it runs
`ensureSyncInfra` with the provided options and renders the result inline.

```typescript
admin: {
  // ...
  featuresFlag: { configCheck: true /* required */ },
  pubsubSetup: {
    ordering: true,
    subscriptionSuffix: "-sub",
    includeDLQ: true,
    ackDeadlineSeconds: 60,
  },
}
```

The same action is available as `POST /config-check/setup-pubsub` and supports
`Accept: application/json` for scripting.

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
- MERGE-based upserts (INSERT … ON CONFLICT / MERGE)
- Delete by primary key
- Schema introspection (for health checks)
- Automatic column migration (`addColumns`)
- ISO 8601 strings in `TIMESTAMP` columns are wrapped as `TIMESTAMP('...')` literals

### Authentication

- **Production (Cloud Run / Cloud Functions)**: credentials are automatic via ADC — just pass `projectId`
- **Local development**: run `gcloud auth application-default login`

## Sync Admin

The optional admin endpoint provides a web UI for monitoring and managing the sync pipeline.

### Features

| Feature          | Flag          | Description                                                           |
| ---------------- | ------------- | --------------------------------------------------------------------- |
| **Health Check** | `healthCheck` | Compare expected schema (from Zod) vs actual SQL columns              |
| **Force Sync**   | `manualSync`  | Re-sync all documents from a Firestore collection                     |
| **View Queues**  | `viewQueue`   | Inspect pending items in the per-repo queue                           |
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

The handler is then available in `sync.functions.adminsync` — already wrapped as a Cloud Function.

If you omit `onRequest`, the raw handler is exposed and you wrap it manually:

```typescript
import { onRequest } from "firebase-functions/v2/https";

export const adminsync = onRequest({ invoker: "public" }, sync.adminHandler!);
```

### Force Sync

Triggered from the admin dashboard or via `POST /force-sync/{repo}` (HTML or
`Accept: application/json`). It re-reads every document of a Firestore collection and
republishes it through the sync pipeline.

The response includes:

| Field          | Description                                         |
| -------------- | --------------------------------------------------- |
| `processed`    | Total documents read from Firestore                 |
| `published`    | Successful Pub/Sub publishes                        |
| `errors`       | Number of documents that failed to publish          |
| `errorSamples` | First 5 errors (`{ docId, message }`) for diagnosis |

Errors are also logged via `console.error('[ForceSync:{repo}] doc={docId} failed:', e)`
so they appear in Cloud Logging.

## Generated Functions

`createFirestoreSync` generates these Cloud Functions:

| Function          | Type              | Purpose                               |
| ----------------- | ----------------- | ------------------------------------- |
| `{repo}_onCreate` | Firestore trigger | Publish UPSERT on document create     |
| `{repo}_onUpdate` | Firestore trigger | Publish UPSERT on document update     |
| `{repo}_onDelete` | Firestore trigger | Publish DELETE on document delete     |
| `sync_{repo}`     | PubSub handler    | Process messages and flush to SQL     |
| `adminsync`       | HTTP handler      | Admin UI (if `admin` config provided) |

## Schema Mapping

Zod schemas are automatically mapped to SQL types:

| Zod Type                   | BigQuery Type |
| -------------------------- | ------------- |
| `z.string()`               | `STRING`      |
| `z.number()`               | `FLOAT64`     |
| `z.bigint()`               | `INT64`       |
| `z.boolean()`              | `BOOL`        |
| `z.date()`                 | `TIMESTAMP`   |
| `z.object()` / `z.array()` | `JSON`        |

## Date Handling (`setDateHandling`)

Firestore returns dates as `Timestamp` objects. By default the library leaves them as
`Timestamp` (mode `"preserve"`), which keeps full nanosecond precision but means
consumers must call `.toDate()` themselves and Zod `z.date()` schemas will reject them.

Switch to `"normalize"` once at app startup to convert every `Timestamp` (including
nested ones inside objects/arrays) to a JavaScript `Date` on read:

```typescript
import { setDateHandling } from "@lpdjs/firestore-repo-service";

setDateHandling("normalize");
```

| Mode          | Behavior                                                                       |
| ------------- | ------------------------------------------------------------------------------ |
| `"preserve"`  | (default) Firestore `Timestamp` instances are returned as-is                   |
| `"normalize"` | Recursively convert `Timestamp` → `Date` on every document read                |

This is recommended when using the BigQuery sync (Zod `z.date()` → `TIMESTAMP`) so the
schema validation and SQL serialization both see proper `Date` instances.

Helpers `coerceToDate(value)` and `normalizeTimestamps(value)` are also exported for
manual conversion (e.g. inside custom mappers).

## Custom SQL Adapter

Implement the `SqlAdapter` interface for other databases:

```typescript
import type {
  SqlAdapter,
  SqlDialect,
  SqlColumn,
  SqlTableDef,
} from "@lpdjs/firestore-repo-service/sync";

class MyAdapter implements SqlAdapter {
  get dialect(): SqlDialect {
    /* ... */
  }
  async tableExists(tableName: string): Promise<boolean> {
    /* ... */
  }
  async getTableColumns(tableName: string): Promise<string[]> {
    /* ... */
  }
  async createTable(table: SqlTableDef): Promise<void> {
    /* ... */
  }
  async addColumns(tableName: string, columns: SqlColumn[]): Promise<void> {
    /* ... */
  }
  async insertRows(
    tableName: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    /* ... */
  }
  async upsertRows(
    tableName: string,
    rows: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    /* ... */
  }
  async deleteRows(
    tableName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void> {
    /* ... */
  }
  async executeRaw(sql: string): Promise<void> {
    /* ... */
  }
}
```
