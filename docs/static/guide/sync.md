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
    bigquery: new BigQuery({
      projectId: "my-project",
      location: "us-central1",
    }),
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

| Option            | Type                   | Default            | Description                                                     |
| ----------------- | ---------------------- | ------------------ | --------------------------------------------------------------- |
| `deps`            | `SyncDeps`             | required           | Firebase Functions + PubSub dependencies                        |
| `adapter`         | `SqlAdapter`           | required           | SQL adapter (e.g. `BigQueryAdapter`)                            |
| `topicPrefix`     | `string`               | `"firestore-sync"` | Pub/Sub topic name prefix                                       |
| `batchSize`       | `number`               | `100`              | Max rows per flush batch                                        |
| `flushIntervalMs` | `number`               | `5000`             | Flush interval in ms                                            |
| `autoMigrate`     | `boolean`              | `false`            | Auto-create/migrate tables on first event                       |
| `workerOptions`   | `SyncWorkerOptions`    | —                  | CF v2 options for the worker (`concurrency`, `maxInstances`, …) |
| `admin`           | `adminsyncConfig`      | —                  | Optional admin endpoint config                                  |
| `repos`           | `TypedRepoSyncConfigs` | —                  | Per-repo overrides                                              |

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
   _"UPDATE/MERGE must match at most one source row for each target row"_ when several
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

| Option            | Where            | Default | What it controls                                                            |
| ----------------- | ---------------- | ------- | --------------------------------------------------------------------------- |
| `batchSize`       | top-level config | `100`   | Max rows merged per BigQuery `MERGE` statement                              |
| `flushIntervalMs` | top-level config | `5000`  | Max time a row sits in the in-memory queue before being flushed             |
| `workerOptions`   | top-level config | —       | Cloud Functions v2 options for every worker handler (concurrency, scaling…) |

```typescript
createServers(repos).sync({
  // ...
  batchSize: 500, // bigger batches → fewer DML statements → less quota pressure
  flushIntervalMs: 10_000, // wait longer to fill batches (higher latency, higher throughput)
  workerOptions: {
    concurrency: 5, // process up to 5 messages in parallel per instance
    maxInstances: 1, // ⚠️ keep at 1 per repo to avoid BigQuery serialize-access errors
    minInstances: 0, // set to 1 to avoid cold starts (costs ~$5-15/mo)
    memory: "512MiB",
    timeoutSeconds: 120,
    region: "europe-west1",
    retry: true, // PubSub retries on thrown error → no event loss
  },
});
```

`workerOptions` is forwarded as-is to `onMessagePublished({ topic, ...workerOptions }, …)`.
Any [`PubSubOptions`](https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.v2.pubsub.pubsuboptions)
field is accepted (`cpu`, `vpcConnector`, `serviceAccount`, `secrets`, etc.).

### Concurrency & PubSub ack semantics

Each repo gets its own `SyncQueue` shared across all in-instance invocations
(it lives in the worker's module closure). When `concurrency > 1`, several
PubSub messages are handled in parallel **inside the same Node.js process**
and all enqueue into the same buffer.

`SyncQueue.flush()` coalesces concurrent callers: every parallel handler
awaits the same in-flight write and only resolves once its event has
actually been persisted. This is what makes `await q.flush()` at the end
of the handler safe — PubSub only acks after BigQuery confirmed the write,
so an instance crash before flush never loses an event.

::: tip Dead-letter & infinite retry protection

`onFlushError` re-publishes failed events to `{topicPrefix}-{repoName}-dlq`
and re-throws if that publish itself fails — PubSub then redelivers the
original message instead of acking. To avoid an infinite redelivery loop on
a poison message, configure a **dead-letter policy on the PubSub
subscription** (Cloud Functions v2 / Eventarc subscription) with e.g.
`maxDeliveryAttempts: 5`. Events are idempotent thanks to the
`__sync_version` column, so retries never corrupt data.
:::

::: tip Recommended defaults for production

- Low traffic (< 10 writes/s/repo): `batchSize: 100`, `flushIntervalMs: 5_000`,
  `concurrency: 5`, `maxInstances: 1`.
- Medium (10-100 writes/s/repo): `batchSize: 500`, `flushIntervalMs: 10_000`,
  `concurrency: 20`, `maxInstances: 3`.
- High (> 100 writes/s/repo): `batchSize: 500–1000`, `flushIntervalMs: 10_000`,
  `concurrency: 40`, `maxInstances: 5+` — the Storage Write API has no
  per-table concurrency cap, so scale horizontally as needed.
  :::

## BigQuery Adapter

The library ships a single BigQuery adapter that streams rows through the
**BigQuery Storage Write API** in **CDC mode** (Change Data Capture).
Multiple Cloud Function instances can write in parallel with no
concurrency cap, it is ~50% cheaper than legacy streaming inserts, and
out-of-order events are deduplicated by `_CHANGE_SEQUENCE_NUMBER` derived
from each event's `__sync_version`.

The Storage Write client is an **optional peer dependency** — install it
in your functions project:

```bash
npm install @google-cloud/bigquery-storage @google-cloud/bigquery
```

```typescript
import { BigQuery } from "@google-cloud/bigquery";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";

const adapter = new BigQueryAdapter({
  projectId: "my-project",
  datasetId: "firestore_sync",
  bigquery: new BigQuery({ projectId: "my-project" }),
  // Background CDC merge cadence — see "About maxStaleness" below.
  maxStaleness: "INTERVAL 15 MINUTE",
});
```

The adapter handles:

- Table creation via DDL with `PRIMARY KEY ... NOT ENFORCED` and clustering
  on the PK (required by CDC mode)
- Streaming UPSERTs and DELETEs through the default stream (at-least-once,
  no stream finalization needed)
- Schema introspection (for health checks)
- Automatic column migration (`addColumns`) with type-drift detection
- ISO 8601 strings and `Date` instances in `TIMESTAMP` columns are encoded
  as epoch microseconds (the wire format the Storage Write API expects)

### Authentication

- **Production (Cloud Run / Cloud Functions)**: credentials are automatic via ADC — just pass `projectId`
- **Local development**: run `gcloud auth application-default login`
- The service account needs `bigquery.tables.updateData` (granted by
  `roles/bigquery.dataEditor`)

### About `maxStaleness`

CDC writes land in BigQuery's **change buffer**; rows only become visible
in the base table once an asynchronous **MERGE** applies the buffer.
`max_staleness` is the SLO for that merge:

- **`INTERVAL 0`** (BigQuery's silent default if you omit the option) —
  every `SELECT` triggers a synchronous merge of the entire buffer before
  returning results. Cheap-looking, but it makes reads slow and expensive
  on busy tables and defeats the point of CDC.
- **`INTERVAL N MINUTE`** — BigQuery runs the MERGE in the background at
  most every N minutes (free, doesn't block reads). Reads against the
  table see data up to N minutes stale. The library defaults to
  **15 minutes** — a good production tradeoff between cost and freshness.
- For development you can set `INTERVAL 1 MINUTE` if you need to see your
  writes quickly in the BigQuery UI.

### Migrating tables created by older versions of this library

Tables originally created by the legacy MERGE-based adapter (≤ 2.3.x) do
not have a PK constraint. Before deploying, run once per table:

```sql
ALTER TABLE `dataset.posts`
  ADD PRIMARY KEY (post_id) NOT ENFORCED,
  SET OPTIONS (max_staleness = INTERVAL 15 MINUTE);
```

(Clustering can only be set at table creation; if your table is not
clustered on the PK, recreate it with `CREATE TABLE … AS SELECT …` or
accept the read-time penalty — Storage Write CDC still works.)

## Schema Evolution

`autoMigrate` adds columns when your Zod schema gains fields. It **never**
changes the type of an existing column — BigQuery itself only allows narrow
widenings (`INT64 → NUMERIC → BIGNUMERIC`, `DATE → DATETIME → TIMESTAMP`),
and a wrong implicit conversion would silently corrupt data.

Starting with v2.3.x the worker therefore detects type drift and throws
`SchemaTypeMismatchError` on the first event:

```
Schema drift detected on `posts`: column `view_count` has type STRING in
BigQuery but the current Zod schema maps it to INT64. BigQuery cannot
safely convert between these types — to resolve, either (a) keep the
BigQuery type and add a transform in your repo to coerce values,
(b) rename the field in your Zod schema (creates a new column), or
(c) drop & recreate the table.
```

This is a **fail-fast** by design: the alternative is every flush failing
with a cryptic cast error, the dead-letter queue filling up, and PubSub
retrying forever.

### Recommended workflow

Treat Firestore document schemas as **append-only**. When you must change
the type of a field:

1. **Rename the field in Zod** (`view_count` → `view_count_v2`). The next
   migration adds the new column; old rows keep `NULL` until backfilled.
2. **Backfill** with a one-off SQL job: `UPDATE … SET view_count_v2 = CAST(view_count AS INT64)`.
3. **Drop the old column** once writes have moved over.

If you really need to mutate a column in-place, do it manually before
deploying the new code (`ALTER TABLE x ALTER COLUMN y SET DATA TYPE …` —
allowed only for the widenings BigQuery accepts).

## Sync Admin

The optional admin endpoint provides a web UI for monitoring and managing the sync pipeline.

### Features

| Feature          | Flag          | Description                                                           |
| ---------------- | ------------- | --------------------------------------------------------------------- |
| **Health Check** | `healthCheck` | Compare expected schema (from Zod) vs actual SQL columns              |
| **Force Sync**   | `manualSync`  | Re-sync all documents from a Firestore collection                     |
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

| Mode          | Behavior                                                        |
| ------------- | --------------------------------------------------------------- |
| `"preserve"`  | (default) Firestore `Timestamp` instances are returned as-is    |
| `"normalize"` | Recursively convert `Timestamp` → `Date` on every document read |

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
