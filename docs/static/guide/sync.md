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
import { createServers } from "@lpdjs/firestore-repo-service";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";
import { onRequest } from "firebase-functions/v2/https";

const servers = createServers(repos, { onRequest });

const sync = servers.sync({
  deps: { firestoreTriggers, pubsubHandler, pubsub: new PubSub() },
  adapter: new BigQueryAdapter({
    bigquery: new BigQuery({ projectId: "my-project", location: "us-central1" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  admin: {
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

> The shared `onRequest` is automatically forwarded to the sync admin so the bundled `adminsync` Cloud Function is generated for you. You only need to pass `admin.onRequest` explicitly if you want to override it.

## Configuration

### `createServers(repos).sync(config)`

The unified wrapper that creates triggers, workers, and the optional admin server (using the repository registry already bound to `createServers`).

| Option            | Type                                                  | Default            | Description                                                       |
| ----------------- | ----------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `deps`            | `SyncDeps`                                            | required           | Firebase Functions + PubSub dependencies                          |
| `adapter`         | `SqlAdapter`                                          | required           | SQL adapter (e.g. `BigQueryAdapter`)                              |
| `topicPrefix`     | `string`                                              | `"firestore-sync"` | Pub/Sub topic name prefix                                         |
| `batchSize`       | `number`                                              | `100`              | Max rows per flush batch                                          |
| `flushIntervalMs` | `number`                                              | `5000`             | Flush interval in ms                                              |
| `autoMigrate`     | `boolean`                                             | `false`            | Auto-create/migrate tables on first event                         |
| `workerOptions`   | `SyncWorkerOptions`                                   | —                  | CF v2 options for the worker (`concurrency`, `maxInstances`, …)   |
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

## Out-of-Order Delivery Protection

Pub/Sub does **not** guarantee message order, and Cloud Functions v2 deliberately
exposes no way to enable `enableMessageOrdering` on the auto-created push subscription
behind `onMessagePublished`. For Firestore sync this means rapid successive writes to
the same document (e.g. `create` then `update`) could otherwise be flushed to SQL out
of order, leaving stale data.

The library handles this **at the application level**:

1. Every `SyncEvent` published by a trigger carries a `version` field — the publish
   time `Date.now()` in milliseconds.
2. The worker stamps the row with this value in a hidden `__sync_version` column
   (auto-added by `zodSchemaToColumns` and `autoMigrate`).
3. The BigQuery `MERGE` only updates the row when the incoming version is strictly
   greater than the stored one:

   ```sql
   WHEN MATCHED
     AND (T.`__sync_version` IS NULL OR S.`__sync_version` > T.`__sync_version`)
   THEN UPDATE SET …
   ```

4. Within a single batch, the queue dedupes upserts per `docId` keeping only the row
   with the highest `version` — which avoids the BigQuery error
   *"UPDATE/MERGE must match at most one source row for each target row"* when several
   updates to the same document are flushed together.

**You don't need to configure anything.** Out-of-order updates are silently dropped,
the most recent write always wins. Existing tables get the `__sync_version` column
added automatically on the next worker invocation when `autoMigrate: true`.

::: tip Older deployments
Rows that pre-date this version have `__sync_version = NULL`. The MERGE treats `NULL`
as "always update", so the first incoming event after upgrade fills it in. After that
the version comparison kicks in normally.
:::

::: warning DELETE races
A `DELETE` event arriving after a newer `UPSERT` for the same document **will** delete
the row. Firestore deletes are usually terminal so this is rarely a problem in practice,
but if your domain re-creates documents under the same id you should add an
application-level tombstone column.
:::

## BigQuery Topic & Subscription Setup

You don't need to pre-create anything. On first deploy:

- Cloud Functions v2 creates the trigger topic (`{topicPrefix}-{repoName}`) via Eventarc.
- The worker creates the dead-letter topic (`{topicPrefix}-{repoName}-dlq`) the first
  time a flush fails.

::: info Why the library doesn't pre-create subscriptions
A previous version exposed an `ensureSyncInfra` helper that created pull subscriptions
with `enableMessageOrdering: true`. It was a dead-end — Cloud Functions v2 ignores
pre-created subscriptions and always uses its own Eventarc-managed push subscription.
The helper has been removed in favour of application-level versioning (see above).
:::

## Tuning & Scaling

Three knobs let you trade latency, throughput and BigQuery quota pressure:

| Option              | Where                  | Default | What it controls                                                            |
| ------------------- | ---------------------- | ------- | --------------------------------------------------------------------------- |
| `batchSize`         | top-level config       | `100`   | Max rows merged per BigQuery `MERGE` statement                              |
| `flushIntervalMs`   | top-level config       | `5000`  | Max time a row sits in the in-memory queue before being flushed             |
| `workerOptions`     | top-level config       | —       | Cloud Functions v2 options for every worker handler (concurrency, scaling…) |

```typescript
createServers(repos).sync({
  // ...
  batchSize: 500,         // bigger batches → fewer DML statements → less quota pressure
  flushIntervalMs: 10_000, // wait longer to fill batches (higher latency, higher throughput)
  workerOptions: {
    concurrency: 10,       // process up to 10 messages in parallel per instance
    maxInstances: 10,      // cap horizontal scaling
    minInstances: 0,       // set to 1 to avoid cold starts (costs ~$5-15/mo)
    memory: "512MiB",
    timeoutSeconds: 120,
    region: "europe-west1",
  },
});
```

`workerOptions` is forwarded as-is to `onMessagePublished({ topic, ...workerOptions }, …)`.
Any [`PubSubOptions`](https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.v2.pubsub.pubsuboptions)
field is accepted (`cpu`, `vpcConnector`, `serviceAccount`, `secrets`, etc.).

::: warning BigQuery DML quota
The default BigQuery quota is **2 concurrent DML statements per table**. With
`concurrency: 10` and `maxInstances: 10` you can have up to 100 in-flight MERGEs;
make sure they target distinct tables (i.e. distinct repos) or you'll hit
`quotaExceeded` and Pub/Sub will retry. Larger `batchSize` + longer `flushIntervalMs`
is the simplest fix.
:::

::: tip Recommended defaults for production
- Low traffic (< 10 writes/s/repo): defaults are fine.
- Medium (10-100 writes/s/repo): `batchSize: 500`, `flushIntervalMs: 10_000`,
  `concurrency: 5`, `maxInstances: 10`.
- High (> 100 writes/s/repo): consider one repo per Cloud Function (already the case)
  and/or migrate inserts to the BigQuery Storage Write API.
:::

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

Same as the Admin Server — supports HTTP Basic Auth, a Firebase `AuthExtension`,
or a custom middleware function:

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

#### Firebase Auth (unified with admin / crud)

The `auth` field also accepts the `AuthExtension` returned by
`firebaseAuth({ ... })` — the same one used by `servers.admin()` and
`servers.crud()`. The inline login page, session cookies and `allow()`
callback work identically:

```typescript
import { firebaseAuth } from "@lpdjs/firestore-repo-service/servers/auth";
import { getAuth } from "firebase-admin/auth";

admin: {
  auth: firebaseAuth({
    getAuth: () => getAuth(),
    mode: "cookie",
    apiKey: process.env.FIREBASE_WEB_API_KEY!,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN!,
    allow: ({ claims }) =>
      claims.role === "superAdmin" ? { role: "superAdmin" } : null,
  }),
  featuresFlag: { healthCheck: true, configCheck: true },
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

`servers.sync(...)` generates these Cloud Functions:

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
