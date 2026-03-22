# Firestore → SQL Sync

Répliquez automatiquement vos collections Firestore vers une base SQL (BigQuery, etc.) via Cloud Pub/Sub.

## Architecture

```
Firestore Triggers → Cloud Pub/Sub → Worker → Base SQL
      (onCreate/onUpdate/onDelete)           (BigQuery, etc.)
```

Chaque modification de document dans Firestore publie un message sur un topic Pub/Sub dédié au repo.
Un worker s'abonne à ces topics, regroupe les changements en batch, et les flush vers SQL.

## Démarrage rapide

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

// Export des triggers + handlers PubSub
export const {
  users_onCreate, users_onUpdate, users_onDelete, sync_users,
  posts_onCreate, posts_onUpdate, posts_onDelete, sync_posts,
} = sync.functions;

// Export de l'admin
export const syncAdmin = onRequest(sync.adminHandler!);
```

## Configuration

### `createFirestoreSync(repos, config)`

Le wrapper unifié qui crée les triggers, les workers et le serveur admin optionnel.

| Option | Type | Défaut | Description |
|--------|------|--------|-------------|
| `deps` | `SyncDeps` | requis | Dépendances Firebase Functions + PubSub |
| `adapter` | `SqlAdapter` | requis | Adaptateur SQL (ex: `BigQueryAdapter`) |
| `topicPrefix` | `string` | `"firestore-sync"` | Préfixe des topics Pub/Sub |
| `batchSize` | `number` | `100` | Nombre max de lignes par flush |
| `flushIntervalMs` | `number` | `5000` | Intervalle de flush en ms |
| `autoMigrate` | `boolean` | `false` | Créer/migrer les tables automatiquement |
| `admin` | `SyncAdminConfig` | — | Configuration optionnelle de l'admin |
| `repos` | `TypedRepoSyncConfigs` | — | Surcharges par repo |

### Dépendances (`deps`)

Tous les modules Firebase/GCP sont injectés — la librairie ne les importe jamais directement :

```typescript
deps: {
  firestoreTriggers, // firebase-functions/v2/firestore
  pubsubHandler,     // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

### Config par repo (`repos`)

| Option | Type | Description |
|--------|------|-------------|
| `tableName` | `string` | Nom de la table SQL (par défaut : nom du repo) |
| `exclude` | `string[]` | Champs à exclure du SQL |
| `columnMap` | `Record<string, string>` | Renommage champs → colonnes SQL |
| `triggerPath` | `string` | **Obligatoire pour les collection groups** — pattern du chemin document |

### Collection Groups (`triggerPath`)

Pour les repos avec `isGroup: true`, vous **devez** fournir un `triggerPath` :

```typescript
repos: {
  comments: {
    triggerPath: "posts/{postId}/comments/{docId}",
    tableName: "comments",
  },
}
```

Cela indique à Firebase où écouter les changements de documents car les collection groups couvrent plusieurs chemins.

## Adaptateur BigQuery

```typescript
import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
import { BigQuery } from "@google-cloud/bigquery";

const adapter = new BigQueryAdapter({
  bigquery: new BigQuery({ projectId: "my-project" }),
  datasetId: "firestore_sync",
});
```

L'adaptateur gère :
- Création de tables via DDL
- Insertions en streaming
- Upserts via MERGE
- Suppression par clé primaire
- Introspection du schéma (pour les health checks)

### Authentification

- **Production (Cloud Run / Cloud Functions)** : les credentials sont automatiques via ADC — passez juste `projectId`
- **Développement local** : lancez `gcloud auth application-default login`

## Sync Admin

L'endpoint admin optionnel fournit une interface web pour surveiller et gérer le pipeline de sync.

### Fonctionnalités

| Fonctionnalité | Flag | Description |
|----------------|------|-------------|
| **Health Check** | `healthCheck` | Compare le schéma attendu (Zod) vs les colonnes SQL réelles |
| **Force Sync** | `manualSync` | Re-synchronise tous les documents d'une collection Firestore |
| **View Queues** | `viewQueue` | Inspecte les éléments en attente dans la queue par repo |
| **Config Check** | `configCheck` | Vérifie APIs GCP, topics, tables et IAM — avec commandes `gcloud` pour corriger |

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

### Config Check

L'endpoint `/config-check` vérifie votre configuration GCP :

- **BigQuery API** — est-elle activée et accessible ?
- **Tables BigQuery** — chaque table de repo existe-t-elle ?
- **Topics Pub/Sub** — chaque topic `{topicPrefix}-{repoName}` existe-t-il ?

Pour chaque problème détecté, il affiche :
- Une commande `gcloud` pour corriger
- Un lien direct vers la Console GCP

Supporte `Accept: application/json` pour un usage programmatique.

### Déploiement de l'admin

Le handler admin est un `(req, res) => void` brut — wrappez-le avec `onRequest()` :

```typescript
import { onRequest } from "firebase-functions/v2/https";

export const syncAdmin = onRequest(sync.adminHandler!);
```

## Functions générées

`createFirestoreSync` génère ces Cloud Functions :

| Fonction | Type | Rôle |
|----------|------|------|
| `{repo}_onCreate` | Trigger Firestore | Publie UPSERT à la création |
| `{repo}_onUpdate` | Trigger Firestore | Publie UPSERT à la modification |
| `{repo}_onDelete` | Trigger Firestore | Publie DELETE à la suppression |
| `sync_{repo}` | Handler PubSub | Traite les messages et flush vers SQL |
| `syncAdmin` | Handler HTTP | Interface admin (si `admin` configuré) |

## Mapping des schémas

Les schémas Zod sont automatiquement mappés vers les types SQL :

| Type Zod | Type BigQuery |
|----------|--------------|
| `z.string()` | `STRING` |
| `z.number()` | `FLOAT64` |
| `z.bigint()` | `INT64` |
| `z.boolean()` | `BOOL` |
| `z.date()` | `TIMESTAMP` |
| `z.object()` / `z.array()` | `JSON` |

## Adaptateur SQL personnalisé

Implémentez l'interface `SqlAdapter` pour d'autres bases de données :

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
