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
    bigquery: new BigQuery({ projectId: "my-project", location: "us-central1" }),
    datasetId: "firestore_sync",
  }),
  topicPrefix: "firestore-sync",
  autoMigrate: true,
  ordering: true, // ordre strict par document sur Pub/Sub
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

// Export des triggers + handlers PubSub
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

Le wrapper unifié qui crée les triggers, les workers et le serveur admin optionnel.

| Option            | Type                   | Défaut             | Description                             |
| ----------------- | ---------------------- | ------------------ | --------------------------------------- |
| `deps`            | `SyncDeps`                     | requis             | Dépendances Firebase Functions + PubSub             |
| `adapter`         | `SqlAdapter`                   | requis             | Adaptateur SQL (ex: `BigQueryAdapter`)              |
| `topicPrefix`     | `string`                       | `"firestore-sync"` | Préfixe des topics Pub/Sub                          |
| `batchSize`       | `number`                       | `100`              | Nombre max de lignes par flush                      |
| `flushIntervalMs` | `number`                       | `5000`             | Intervalle de flush en ms                           |
| `autoMigrate`     | `boolean`                      | `false`            | Créer/migrer les tables automatiquement             |
| `ordering`        | `boolean \| (event) => string` | `false`            | Active l'ordering Pub/Sub (par `docId` quand `true`)|
| `admin`           | `adminsyncConfig`              | —                  | Configuration optionnelle de l'admin                |
| `repos`           | `TypedRepoSyncConfigs`         | —                  | Surcharges par repo                                 |

### Dépendances (`deps`)

Tous les modules Firebase/GCP sont injectés — la librairie ne les importe jamais directement :

```typescript
deps: {
  firestoreTriggers, // firebase-functions/v2/firestore
  pubsubHandler,     // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

::: tip Initialisation lazy
`deps.pubsub` et `adapter` acceptent une factory `() => T` pour une initialisation différée.
Cela évite de créer des canaux gRPC ou des connexions BigQuery au chargement du module pour les
Cloud Functions qui n'en ont pas besoin (ex: fonctions HTTP-only partageant le même déploiement).

```typescript
deps: { firestoreTriggers, pubsubHandler, pubsub: () => new PubSub() },
adapter: () => new BigQueryAdapter({ bigquery: new BigQuery(), datasetId: "sync" }),
```
:::

### Config par repo (`repos`)

| Option        | Type                     | Description                                                             |
| ------------- | ------------------------ | ----------------------------------------------------------------------- |
| `tableName`   | `string`                 | Nom de la table SQL (par défaut : nom du repo)                          |
| `exclude`     | `string[]`               | Champs à exclure du SQL                                                 |
| `columnMap`   | `Record<string, string>` | Renommage champs → colonnes SQL                                         |
| `triggerPath` | `string`                 | **Obligatoire pour les collection groups** — pattern du chemin document |

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

## Ordre des messages Pub/Sub

Par défaut, Pub/Sub ne garantit pas l'ordre des messages. Pour la sync Firestore, cela
signifie que des écritures rapides successives sur le même document (ex. `create` puis
`update`) peuvent être flush vers SQL dans le désordre, laissant des données obsolètes.

Passez `ordering: true` pour publier chaque message avec l'id du document comme **clé
d'ordonnancement**. Le broker Pub/Sub livre alors séquentiellement au worker tous les
messages partageant la même clé.

```typescript
const sync = createFirestoreSync(repos, {
  // ...
  ordering: true, // ordre par docId (recommandé)
  // ordering: (event) => `${event.repo}:${event.docId}`, // clé custom
});
```

::: warning La subscription doit être créée avec `enableMessageOrdering: true`
Ce flag est **immuable** sur une subscription Pub/Sub après création. Cloud Functions v2
crée automatiquement les subscriptions **sans** ordering activé : il faut donc les
pré-créer avant `firebase deploy` (ou les supprimer puis recréer). Utilisez le helper
`ensureSyncInfra` ci-dessous, ou le bouton **Setup Pub/Sub** sur la page Config Check
de l'admin.
:::

En cas d'erreur de publish, le publisher appelle automatiquement
`resumePublishing(orderingKey)` — sans cela, tous les messages suivants pour cette clé
seraient silencieusement abandonnés.

## Pré-création des topics & subscriptions (`ensureSyncInfra`)

Helper qui crée de manière idempotente les topics Pub/Sub et les subscriptions push
utilisés par le pipeline de sync, avec le bon flag `enableMessageOrdering`.

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
  messageRetentionDuration: 7 * 24 * 60 * 60, // 7 jours
});
```

| Option                     | Type      | Défaut         | Description                                                |
| -------------------------- | --------- | -------------- | ---------------------------------------------------------- |
| `pubsub`                   | `PubSub`  | requis         | Client Google Cloud Pub/Sub                                |
| `topicPrefix`              | `string`  | requis         | Même valeur que dans `createFirestoreSync`                 |
| `ordering`                 | `boolean` | `false`        | Crée topics/subscriptions avec ordering activé             |
| `subscriptionSuffix`       | `string`  | `"-sub"`       | Suffixe du nom de subscription par topic                   |
| `includeDLQ`               | `boolean` | `false`        | Crée aussi les topics `{topic}-dlq`                        |
| `ackDeadlineSeconds`       | `number`  | défaut GCP     | Ack deadline de la subscription                            |
| `messageRetentionDuration` | `number`  | défaut GCP     | Rétention en secondes                                      |

Les topics et subscriptions existants ne sont pas modifiés (le résultat indique
`created` / `existing`). Si l'ordering est demandé mais qu'une subscription existante
a été créée sans, un warning est émis — il faudra la supprimer et la recréer.

### Branchement dans le dashboard admin (`pubsubSetup`)

Quand `pubsubSetup` est défini sous `admin`, un bouton **⚙ Setup Pub/Sub** apparaît
sur la page `/config-check` (gated par `featuresFlag.configCheck`). Il exécute
`ensureSyncInfra` avec les options fournies et affiche le résultat.

```typescript
admin: {
  // ...
  featuresFlag: { configCheck: true /* requis */ },
  pubsubSetup: {
    ordering: true,
    subscriptionSuffix: "-sub",
    includeDLQ: true,
    ackDeadlineSeconds: 60,
  },
}
```

La même action est disponible via `POST /config-check/setup-pubsub` et supporte
`Accept: application/json` pour le scripting.

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
- Upserts via MERGE (INSERT … ON CONFLICT / MERGE)
- Suppression par clé primaire
- Introspection du schéma (pour les health checks)
- Migration automatique de colonnes (`addColumns`)
- Les chaînes ISO 8601 dans les colonnes `TIMESTAMP` sont wrappées en littéraux `TIMESTAMP('...')`

### Authentification

- **Production (Cloud Run / Cloud Functions)** : les credentials sont automatiques via ADC — passez juste `projectId`
- **Développement local** : lancez `gcloud auth application-default login`

## Sync Admin

L'endpoint admin optionnel fournit une interface web pour surveiller et gérer le pipeline de sync.

### Fonctionnalités

| Fonctionnalité   | Flag          | Description                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------- |
| **Health Check** | `healthCheck` | Compare le schéma attendu (Zod) vs les colonnes SQL réelles                     |
| **Force Sync**   | `manualSync`  | Re-synchronise tous les documents d'une collection Firestore                    |
| **View Queues**  | `viewQueue`   | Inspecte les éléments en attente dans la queue par repo                         |
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

Le handler admin est auto-wrappé quand `onRequest` est fourni dans la config.
Passez `httpsOptions` pour configurer la Cloud Function (invoker, memory, region, etc.) :

```typescript
admin: {
  onRequest,
  httpsOptions: { invoker: "public", memory: "512MiB" },
  auth: { type: "basic", username: "admin", password: "secret" },
  featuresFlag: { healthCheck: true, configCheck: true },
}
```

Le handler est alors disponible dans `sync.functions.adminsync` — déjà wrappé comme Cloud Function.

Si vous omettez `onRequest`, le handler brut est exposé et vous le wrappez manuellement :

```typescript
import { onRequest } from "firebase-functions/v2/https";

export const adminsync = onRequest({ invoker: "public" }, sync.adminHandler!);
```

### Force Sync

Déclenché depuis le dashboard admin ou via `POST /force-sync/{repo}` (HTML ou
`Accept: application/json`). Re-lit chaque document d'une collection Firestore et
le republie dans le pipeline de sync.

La réponse contient :

| Champ          | Description                                              |
| -------------- | -------------------------------------------------------- |
| `processed`    | Total de documents lus depuis Firestore                  |
| `published`    | Publishes Pub/Sub réussis                                |
| `errors`       | Nombre de documents qui n'ont pas pu être publiés        |
| `errorSamples` | 5 premières erreurs (`{ docId, message }`) pour diagnostiquer |

Les erreurs sont également loggées via
`console.error('[ForceSync:{repo}] doc={docId} failed:', e)` pour apparaître dans
Cloud Logging.

## Functions générées

`createFirestoreSync` génère ces Cloud Functions :

| Fonction          | Type              | Rôle                                   |
| ----------------- | ----------------- | -------------------------------------- |
| `{repo}_onCreate` | Trigger Firestore | Publie UPSERT à la création            |
| `{repo}_onUpdate` | Trigger Firestore | Publie UPSERT à la modification        |
| `{repo}_onDelete` | Trigger Firestore | Publie DELETE à la suppression         |
| `sync_{repo}`     | Handler PubSub    | Traite les messages et flush vers SQL  |
| `adminsync`       | Handler HTTP      | Interface admin (si `admin` configuré) |

## Mapping des schémas

Les schémas Zod sont automatiquement mappés vers les types SQL :

| Type Zod                   | Type BigQuery |
| -------------------------- | ------------- |
| `z.string()`               | `STRING`      |
| `z.number()`               | `FLOAT64`     |
| `z.bigint()`               | `INT64`       |
| `z.boolean()`              | `BOOL`        |
| `z.date()`                 | `TIMESTAMP`   |
| `z.object()` / `z.array()` | `JSON`        |

## Gestion des dates (`setDateHandling`)

Firestore retourne les dates sous forme de `Timestamp`. Par défaut la lib les laisse
en `Timestamp` (mode `"preserve"`), ce qui préserve la précision nanoseconde mais
oblige les consommateurs à appeler `.toDate()` eux-mêmes — et les schémas Zod
`z.date()` les rejettent.

Passez en `"normalize"` une fois au démarrage de l'app pour convertir tout `Timestamp`
(y compris ceux imbriqués dans objets/tableaux) en `Date` JavaScript à la lecture :

```typescript
import { setDateHandling } from "@lpdjs/firestore-repo-service";

setDateHandling("normalize");
```

| Mode          | Comportement                                                                  |
| ------------- | ----------------------------------------------------------------------------- |
| `"preserve"`  | (défaut) Les `Timestamp` Firestore sont retournés tels quels                  |
| `"normalize"` | Convertit récursivement `Timestamp` → `Date` à chaque lecture                 |

Recommandé avec la sync BigQuery (Zod `z.date()` → `TIMESTAMP`) pour que la
validation Zod et la sérialisation SQL voient toutes les deux de vraies `Date`.

Les helpers `coerceToDate(value)` et `normalizeTimestamps(value)` sont aussi exportés
pour conversion manuelle (ex. dans un mapper custom).

## Adaptateur SQL personnalisé

Implémentez l'interface `SqlAdapter` pour d'autres bases de données :

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
