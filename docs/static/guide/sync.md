# Firestore → Storage & Search Sync

Automatically replicate Firestore collections to SQL databases (BigQuery, etc.) and search engines (Meilisearch, etc.) via Cloud Pub/Sub.

## Architecture

```
Firestore Triggers (onDocumentWritten) → Cloud Pub/Sub → Worker → Target Adapters
             (users_onSync)                                      (BigQuery, Meilisearch...)
```

Each document change in Firestore triggers a single `onDocumentWritten` Cloud Function (`${repoName}_onSync`) that publishes an event (`INSERT`, `UPSERT`, or `DELETE`) to a per-repo Pub/Sub topic.
A worker subscribes to these topics, batches the changes, and flushes them to one or more configured **Sync Adapters** concurrently.

## Quick Start

```typescript
import { createServers } from "@lpdjs/firestore-repo-service";
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { MeilisearchAdapter } from "@lpdjs/firestore-repo-service/sync/meilisearch";
import { BigQuery } from "@google-cloud/bigquery";
import { PubSub } from "@google-cloud/pubsub";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as pubsubHandler from "firebase-functions/v2/pubsub";
import { onRequest } from "firebase-functions/v2/https";

const servers = createServers(repos, { onRequest });

const sync = servers.sync({
  deps: { firestoreTriggers: { onDocumentWritten }, pubsubHandler, pubsub: new PubSub() },
  adapters: [
    new BigQueryAdapter({
      bigquery: new BigQuery({
        projectId: "my-project",
        location: "us-central1",
      }),
      datasetId: "firestore_sync",
    }),
    new MeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "masterKey",
      indexesSettings: {
        users: { searchableAttributes: ["name", "email"], filterableAttributes: ["role"] },
      },
    }),
  ],
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
      adapters: ["bigquery", "meilisearch"], // Fan-out to both
    },
    posts: { columnMap: { docId: "post_id" } },
  },
});

// Export triggers + PubSub handlers
export const {
  users_onSync,
  sync_users,
  posts_onSync,
  sync_posts,
  adminsync,
} = sync.functions;
```

> The shared `onRequest` is automatically forwarded to the sync admin so the bundled `adminsync` Cloud Function is generated for you. You only need to pass `admin.onRequest` explicitly if you want to override it.

## Configuration

### `createServers(repos).sync(config)`

The unified wrapper that creates triggers, workers, and the optional admin server (using the repository registry already bound to `createServers`).

| Option            | Type                                | Default            | Description                                                     |
| ----------------- | ----------------------------------- | ------------------ | --------------------------------------------------------------- |
| `deps`            | `SyncDeps`                          | required           | Firebase Functions (`onDocumentWritten`) + PubSub dependencies  |
| `adapters`        | `SyncAdapter[]`                     | —                  | List of sync adapters (e.g. `[bigquery, meilisearch]`)          |
| `adapter`         | `SyncAdapter`                       | —                  | Single sync adapter (convenience alias for `adapters: [...]`)    |
| `topicPrefix`     | `string`                            | `"firestore-sync"` | Pub/Sub topic name prefix                                       |
| `batchSize`       | `number`                            | `100`              | Max rows per flush batch                                        |
| `flushIntervalMs` | `number`                            | `5000`             | Flush interval in ms                                            |
| `autoMigrate`     | `boolean`                           | `false`            | Auto-create/migrate tables and indexes on first event           |
| `workerOptions`   | `SyncWorkerOptions`                 | —                  | CF v2 options for the worker (`concurrency`, `maxInstances`, …) |
| `admin`           | `adminsyncConfig`                   | —                  | Optional admin endpoint config                                  |
| `repos`           | `TypedRepoSyncConfigs`              | —                  | Per-repo overrides                                              |

### Dependencies (`deps`)

All Firebase/GCP modules are injected — the library never imports them directly:

```typescript
deps: {
  firestoreTriggers: { onDocumentWritten }, // firebase-functions/v2/firestore
  pubsubHandler,                            // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

::: tip Lazy initialization
`deps.pubsub` and `adapters` both accept a factory function `() => T` for lazy initialization.
This avoids creating gRPC channels or BigQuery connections at module-load time for Cloud Functions
that don't need them (e.g. HTTP-only functions sharing the same deploy).

```typescript
deps: { firestoreTriggers: { onDocumentWritten }, pubsubHandler, pubsub: () => new PubSub() },
adapters: [
  () => new BigQueryAdapter({ bigquery: new BigQuery(), datasetId: "sync" }),
  () => new MeilisearchAdapter({ host: "http://localhost:7700", apiKey: "masterKey" }),
],
```

:::

### Per-Repo Config (`repos`)

| Option        | Type                     | Description                                                         |
| ------------- | ------------------------ | ------------------------------------------------------------------- |
| `tableName`   | `string`                 | SQL table / Search index name (defaults to repo name)               |
| `adapters`    | `string[]`               | Filter target adapters for this repo (e.g. `["bigquery"]`)          |
| `exclude`     | `string[]`               | Fields to exclude from sync                                         |
| `columnMap`   | `Record<string, string>` | Rename fields → SQL columns / document properties                  |
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
the same document (e.g. `create` then `update`) could otherwise be flushed out of order, leaving stale data.

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
- The worker creates the dead-letter topic (`{topicPrefix}-{repoName}-{adapterName}-dlq`) the first
  time a flush fails for that adapter.

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
| `batchSize`       | top-level config | `100`   | Max rows merged per flush batch                                             |
| `flushIntervalMs` | top-level config | `5000`  | Max time a row sits in the in-memory queue before being flushed             |
| `workerOptions`   | top-level config | —       | Cloud Functions v2 options for every worker handler (concurrency, scaling…) |

```typescript
createServers(repos).sync({
  // ...
  batchSize: 500, // bigger batches → fewer write requests → less quota pressure
  flushIntervalMs: 10_000, // wait longer to fill batches (higher latency, higher throughput)
  workerOptions: {
    concurrency: 5, // process up to 5 messages in parallel per instance
    maxInstances: 1, // ⚠️ keep at 1 per repo when using SQL without CDC
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

Each repo and target adapter pair gets its own `SyncQueue` shared across all in-instance invocations
(it lives in the worker's module closure). When `concurrency > 1`, several
PubSub messages are handled in parallel **inside the same Node.js process**
and all enqueue into the appropriate buffer.

`SyncQueue.flush()` coalesces concurrent callers: every parallel handler
awaits the same in-flight write and only resolves once its event has
actually been persisted. This is what makes `await q.flush()` at the end
of the handler safe — PubSub only acks after target adapters confirmed the write,
so an instance crash before flush never loses an event.

::: tip Dead-letter & infinite retry protection

`onFlushError` re-publishes failed events to `{topicPrefix}-{repoName}-{adapterName}-dlq`
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
  `concurrency: 40`, `maxInstances: 5+` — the Storage Write API and Meilisearch batching have no
  per-table concurrency cap, so scale horizontally as needed.
:::

## Multi-Adapter Fan-Out & Fault Isolation

You can sync Firestore changes to multiple destinations concurrently (e.g. BigQuery for analytics and Meilisearch for full-text search) by passing an array of adapters:

```typescript
adapters: [bigQueryAdapter, meilisearchAdapter],
repos: {
  users: {
    adapters: ["bigquery", "meilisearch"], // Fans out to both
  },
  logs: {
    adapters: ["bigquery"], // Only sent to BigQuery
  },
}
```

### Complete Fault Isolation

Each destination operates with its own isolated `SyncQueue` and dedicated dead-letter topic (`firestore-sync-users-meilisearch-dlq`). If Meilisearch is temporarily unreachable or experiences an outage, its failed batches are directed to its own DLQ, while BigQuery continues inserting and merging events seamlessly without delay or interruption.

## BigQuery Adapter

The BigQuery adapter streams rows through the **BigQuery Storage Write API** in **CDC mode** (Change Data Capture).
Multiple Cloud Function instances can write in parallel with no concurrency cap, it is ~50% cheaper than legacy streaming inserts, and out-of-order events are deduplicated by `_CHANGE_SEQUENCE_NUMBER` derived from each event's `__sync_version`.

The Storage Write client is an **optional peer dependency** — install it in your functions project:

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

- Table creation via DDL with `PRIMARY KEY ... NOT ENFORCED` and clustering on the PK (required by CDC mode)
- Streaming UPSERTs and DELETEs through the default stream (at-least-once, no stream finalization needed)
- Schema introspection (for health checks)
- Automatic column migration (`addColumns`) with type-drift detection
- ISO 8601 strings and `Date` instances in `TIMESTAMP` columns are encoded as epoch microseconds (the wire format the Storage Write API expects)

### Authentication

- **Production (Cloud Run / Cloud Functions)**: credentials are automatic via ADC — just pass `projectId`
- **Local development**: run `gcloud auth application-default login`
- The service account needs `bigquery.tables.updateData` (granted by `roles/bigquery.dataEditor`)

### About `maxStaleness`

CDC writes land in BigQuery's **change buffer**; rows only become visible in the base table once an asynchronous **MERGE** applies the buffer. `max_staleness` is the SLO for that merge:

- **`INTERVAL 0`** (BigQuery's silent default if you omit the option) — every `SELECT` triggers a synchronous merge of the entire buffer before returning results. Cheap-looking, but it makes reads slow and expensive on busy tables and defeats the point of CDC.
- **`INTERVAL N MINUTE`** — BigQuery runs the MERGE in the background at most every N minutes (free, doesn't block reads). Reads against the table see data up to N minutes stale. The library defaults to **15 minutes** — a good production tradeoff between cost and freshness.
- For development you can set `INTERVAL 1 MINUTE` if you need to see your writes quickly in the BigQuery UI.

## Meilisearch Adapter

The Meilisearch adapter streams Firestore documents into [Meilisearch](https://www.meilisearch.com/) indexes for fast, typo-tolerant full-text search.

The `meilisearch` JavaScript SDK is an **optional peer dependency**:

```bash
npm install meilisearch
```

```typescript
import { MeilisearchAdapter } from "@lpdjs/firestore-repo-service/sync/meilisearch";

const meilisearchAdapter = new MeilisearchAdapter({
  host: "http://localhost:7700",
  apiKey: "masterKey",
  indexesSettings: {
    users: {
      searchableAttributes: ["name", "email", "bio"],
      filterableAttributes: ["role", "status", "createdAt"],
      sortableAttributes: ["createdAt", "name"],
    },
    posts: {
      searchableAttributes: ["title", "content"],
      filterableAttributes: ["status", "userId"],
    },
  },
});
```

The adapter handles:
- Automatic index creation on first event with primary key configuration.
- Syncing index settings (`indexesSettings`) like searchable, filterable, and sortable attributes.
- High-throughput document batching (`addDocuments`) and document deletions (`deleteDocuments`).
- Index statistics and health inspection via `/health` and `/config-check`.

## Schema Evolution

`autoMigrate` adds columns when your Zod schema gains fields. It **never** changes the type of an existing column — BigQuery itself only allows narrow widenings (`INT64 → NUMERIC → BIGNUMERIC`, `DATE → DATETIME → TIMESTAMP`), and a wrong implicit conversion would silently corrupt data.

Starting with v2.3.x the worker detects type drift and throws `SchemaTypeMismatchError` on the first event:

```
Schema drift detected on `posts`: column `view_count` has type STRING in
BigQuery but the current Zod schema maps it to INT64. BigQuery cannot
safely convert between these types — to resolve, either (a) keep the
BigQuery type and add a transform in your repo to coerce values,
(b) rename the field in your Zod schema (creates a new column), or
(c) drop & recreate the table.
```

### Recommended workflow

Treat Firestore document schemas as **append-only**. When you must change the type of a field:

1. **Rename the field in Zod** (`view_count` → `view_count_v2`). The next migration adds the new column; old rows keep `NULL` until backfilled.
2. **Backfill** with a one-off SQL job: `UPDATE … SET view_count_v2 = CAST(view_count AS INT64)`.
3. **Drop the old column** once writes have moved over.

## Sync Admin

The optional admin endpoint provides a web UI for monitoring and managing the sync pipeline.

### Features

| Feature          | Flag          | Description                                                           |
| ---------------- | ------------- | --------------------------------------------------------------------- |
| **Health Check** | `healthCheck` | Compare expected schema vs actual SQL columns & Search index stats    |
| **Force Sync**   | `manualSync`  | Re-sync all documents from a Firestore collection to all targets      |
| **Config Check** | `configCheck` | Verify GCP APIs, Meilisearch, topics, tables, and IAM permissions     |

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

### Config Check

The `/config-check` endpoint verifies your GCP and Search engine setup:

- **BigQuery API & Tables** — is it reachable and do the repo tables exist?
- **Meilisearch API & Indexes** — is the server reachable and are indexes initialized?
- **Pub/Sub topics** — does each `{topicPrefix}-{repoName}` topic exist?

For each issue, it shows a `gcloud` command or hint to fix it.

### Force Sync

Triggered from the admin dashboard or via `POST /force-sync/{repo}` (HTML or `Accept: application/json`). It re-reads every document of a Firestore collection and pushes it through all active target adapters for that repository.

## Generated Functions

`servers.sync(...)` generates these Cloud Functions:

| Function          | Type              | Purpose                               |
| ----------------- | ----------------- | ------------------------------------- |
| `{repo}_onSync`   | Firestore trigger | Single `onDocumentWritten` trigger    |
| `sync_{repo}`     | PubSub handler    | Process messages and flush to targets |
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

Firestore returns dates as `Timestamp` objects. Switch to `"normalize"` once at app startup to convert every `Timestamp` to a JavaScript `Date` on read:

```typescript
import { setDateHandling } from "@lpdjs/firestore-repo-service";

setDateHandling("normalize");
```

## Custom Sync Adapter

Implement the universal `SyncAdapter` interface for other storage or search engines:

```typescript
import type { SyncAdapter, SyncHealthResult } from "@lpdjs/firestore-repo-service/sync";

class MyCustomAdapter implements SyncAdapter {
  readonly name = "elasticsearch"; // Identifier used in repoConfigs.adapters

  async targetExists(targetName: string): Promise<boolean> {
    // Check if index/table exists
    return true;
  }

  async upsert(
    targetName: string,
    items: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    // Bulk upsert documents
  }

  async delete(
    targetName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void> {
    // Bulk delete documents by IDs
  }

  async ensureTarget(options: {
    targetName: string;
    primaryKey: string;
    schema?: any;
    exclude?: string[];
    columnMap?: Record<string, string>;
  }): Promise<void> {
    // Auto-create table/index if not exists
  }

  async healthCheck(options: {
    targetName: string;
    primaryKey: string;
    schema?: any;
    repoConfig?: any;
  }): Promise<SyncHealthResult> {
    return {
      healthy: true,
      targetName: options.targetName,
      targetExists: true,
      error: null,
    };
  }
}
```
