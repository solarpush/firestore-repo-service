# Firestore → Storage & Search Sync

Répliquez automatiquement vos collections Firestore vers des bases SQL (BigQuery, etc.) et des moteurs de recherche (Meilisearch, etc.) via Cloud Pub/Sub.

## Architecture

```
Firestore Triggers (onDocumentWritten) → Cloud Pub/Sub → Worker → Adaptateurs cibles
             (users_onSync)                                      (BigQuery, Meilisearch...)
```

Chaque modification de document dans Firestore déclenche un trigger `onDocumentWritten` Cloud Function (`${repoName}_onSync`) qui publie un événement (`INSERT`, `UPSERT` ou `DELETE`) sur un topic Pub/Sub dédié au repository.
Un worker s'abonne à ces topics, regroupe les changements en batch, et les flush vers un ou plusieurs **Sync Adapters** configurés en parallèle.

## Démarrage rapide

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
      adapters: ["bigquery", "meilisearch"], // Fan-out vers les deux
    },
    posts: { columnMap: { docId: "post_id" } },
  },
});

// Export des triggers + handlers PubSub
export const {
  users_onSync,
  sync_users,
  posts_onSync,
  sync_posts,
  adminsync,
} = sync.functions;
```

> Le `onRequest` partagé est automatiquement transmis à l'admin sync — la Cloud Function `adminsync` est donc générée pour vous. Passez explicitement `admin.onRequest` uniquement pour le surcharger.

## Configuration

### `createServers(repos).sync(config)`

Le wrapper unifié qui crée les triggers, les workers et le serveur admin optionnel (à partir du registre déjà lié à `createServers`).

| Option            | Type                                | Défaut             | Description                                                |
| ----------------- | ----------------------------------- | ------------------ | ---------------------------------------------------------- |
| `deps`            | `SyncDeps`                          | requis             | Dépendances Firebase Functions (`onDocumentWritten`) + PubSub |
| `adapters`        | `SyncAdapter[]`                     | —                  | Liste d'adaptateurs de synchronisation (ex: `[bigquery, meilisearch]`) |
| `adapter`         | `SyncAdapter`                       | —                  | Adaptateur unique (alias pratique pour `adapters: [...]`)  |
| `topicPrefix`     | `string`                            | `"firestore-sync"` | Préfixe des topics Pub/Sub                                 |
| `batchSize`       | `number`                            | `100`              | Nombre max de lignes par flush                             |
| `flushIntervalMs` | `number`                            | `5000`             | Intervalle de flush en ms                                  |
| `autoMigrate`     | `boolean`                           | `false`            | Créer/migrer les tables et index automatiquement           |
| `workerOptions`   | `SyncWorkerOptions`                 | —                  | Options CF v2 du worker (`concurrency`, `maxInstances`, …) |
| `admin`           | `adminsyncConfig`                   | —                  | Configuration optionnelle de l'admin                       |
| `repos`           | `TypedRepoSyncConfigs`              | —                  | Surcharges par repo                                        |

### Dépendances (`deps`)

Tous les modules Firebase/GCP sont injectés — la librairie ne les importe jamais directement :

```typescript
deps: {
  firestoreTriggers: { onDocumentWritten }, // firebase-functions/v2/firestore
  pubsubHandler,                            // firebase-functions/v2/pubsub
  pubsub: new PubSub({ projectId: "my-project" }),
}
```

::: tip Initialisation lazy
`deps.pubsub` et `adapters` acceptent une factory `() => T` pour une initialisation différée.
Cela évite de créer des canaux gRPC ou des connexions BigQuery au chargement du module pour les
Cloud Functions qui n'en ont pas besoin (ex: fonctions HTTP-only partageant le même déploiement).

```typescript
deps: { firestoreTriggers: { onDocumentWritten }, pubsubHandler, pubsub: () => new PubSub() },
adapters: [
  () => new BigQueryAdapter({ bigquery: new BigQuery(), datasetId: "sync" }),
  () => new MeilisearchAdapter({ host: "http://localhost:7700", apiKey: "masterKey" }),
],
```

:::

### Config par repo (`repos`)

| Option        | Type                     | Description                                                             |
| ------------- | ------------------------ | ----------------------------------------------------------------------- |
| `tableName`   | `string`                 | Nom de la table SQL / Index Meilisearch (par défaut : nom du repo)      |
| `adapters`    | `string[]`               | Filtre des adaptateurs cibles pour ce repo (ex: `["bigquery"]`)         |
| `exclude`     | `string[]`               | Champs à exclure de la synchronisation                                  |
| `columnMap`   | `Record<string, string>` | Renommage champs → colonnes SQL / propriétés document                   |
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

## Protection contre la livraison désordonnée

Pub/Sub **ne garantit pas** l'ordre des messages, et Cloud Functions v2 n'expose
volontairement aucun moyen d'activer `enableMessageOrdering` sur la subscription push
auto-créée derrière `onMessagePublished`. Pour la sync Firestore, cela signifierait que
des écritures rapides successives sur le même document (`create` puis `update`) puissent
être flush dans le désordre, laissant des données obsolètes.

La librairie gère ça **au niveau applicatif** :

1. Chaque `SyncEvent` publié par un trigger contient un champ `version` — le timestamp `Date.now()` en millisecondes.
2. Le worker insère cette valeur dans une colonne masquée `__sync_version` (auto-ajoutée par `zodSchemaToColumns` et `autoMigrate`).
3. Le `MERGE` BigQuery ne met à jour la ligne que si la version entrante est strictement supérieure à la version stockée :

   ```sql
   WHEN MATCHED
     AND (T.`__sync_version` IS NULL OR S.`__sync_version` > T.`__sync_version`)
   THEN UPDATE SET …
   ```


::: tip Anciens déploiements
Les lignes antérieures à cette version ont `__sync_version = NULL`. Le MERGE traite
`NULL` comme « toujours mettre à jour », donc le premier event entrant après upgrade la
remplit. Ensuite la comparaison fonctionne normalement.
:::

::: warning Course aux DELETE
Un event `DELETE` arrivant après un `UPSERT` plus récent du même document **supprimera**
la ligne. En pratique les deletes Firestore sont terminaux donc c'est rarement un
problème, mais si votre métier recrée des documents sous le même id, ajoutez une
colonne tombstone applicative.
:::

## Création des topics & subscriptions

Pas besoin de pré-créer quoi que ce soit. Au premier déploiement :

- Cloud Functions v2 crée le topic du trigger (`{topicPrefix}-{repoName}`) via Eventarc.
- Le worker crée le topic dead-letter (`{topicPrefix}-{repoName}-dlq`) la première fois
  qu'un flush échoue.

::: info Pourquoi la lib ne pré-crée plus de subscriptions
Une version précédente exposait un helper `ensureSyncInfra` qui créait des subscriptions
pull avec `enableMessageOrdering: true`. C'était une impasse — Cloud Functions v2 ignore
les subscriptions pré-existantes et utilise toujours sa propre subscription push gérée
par Eventarc. Le helper a été supprimé au profit du versioning applicatif (voir
ci-dessus).
:::

## Tuning & Scaling

Trois leviers pour ajuster latence, throughput et pression sur les quotas BigQuery :

| Option            | Où               | Défaut | Ce qu'il contrôle                                            |
| ----------------- | ---------------- | ------ | ------------------------------------------------------------ |
| `batchSize`       | config top-level | `100`  | Nombre max de lignes par `MERGE` BigQuery                    |
| `flushIntervalMs` | config top-level | `5000` | Délai max avant de flush la queue mémoire                    |
| `workerOptions`   | config top-level | —      | Options Cloud Functions v2 du worker (concurrence, scaling…) |

```typescript
createServers(repos).sync({
  // ...
  batchSize: 500, // batches plus gros → moins de DML → moins de quota
  flushIntervalMs: 10_000, // attendre plus pour remplir les batches
  workerOptions: {
    concurrency: 5, // jusqu'à 5 messages traités en parallèle par instance
    maxInstances: 1, // ⚠️ garder 1 par repo pour éviter les "serialize access" BigQuery
    minInstances: 0, // mettre à 1 pour éviter le cold start (~5-15$/mois)
    memory: "512MiB",
    timeoutSeconds: 120,
    region: "europe-west1",
    retry: true, // PubSub retry sur throw → aucun event perdu
  },
});
```

`workerOptions` est transmis tel quel à `onMessagePublished({ topic, ...workerOptions }, …)`.
Tous les champs de [`PubSubOptions`](https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.v2.pubsub.pubsuboptions)
sont acceptés (`cpu`, `vpcConnector`, `serviceAccount`, `secrets`, etc.).

### Concurrence & sémantique d'ack PubSub

Chaque repo possède sa propre `SyncQueue` partagée par toutes les invocations
de l'instance (elle vit dans la closure du module worker). Avec
`concurrency > 1`, plusieurs messages PubSub sont traités en parallèle **dans
le même process Node.js** et enqueue tous dans le même buffer.

`SyncQueue.flush()` coalesce les appels concurrents : chaque handler en
parallèle attend la même écriture en cours et ne résout qu'une fois son
event réellement persisté. C'est ce qui rend le `await q.flush()` final du
handler safe — PubSub ack uniquement après confirmation BigQuery, donc un
crash d'instance avant flush ne perd jamais d'event.

::: tip Dead-letter & protection contre le retry infini

`onFlushError` re-publie les events échoués sur `{topicPrefix}-{repoName}-dlq`
et re-throw si ce publish échoue lui aussi — PubSub redélivre alors le
message original au lieu d'ack. Pour éviter une boucle de redélivrance
infinie sur un poison message, configurer une **dead-letter policy sur la
subscription PubSub** (subscription Cloud Functions v2 / Eventarc) avec par
exemple `maxDeliveryAttempts: 5`. Les events sont idempotents grâce à la
colonne `__sync_version`, donc les retries ne corrompent jamais la donnée.
:::

::: tip Recommandations en prod

- Faible trafic (< 10 writes/s/repo) : `batchSize: 100`, `flushIntervalMs: 5_000`,
  `concurrency: 5`, `maxInstances: 1`.
- Moyen (10-100 writes/s/repo) : `batchSize: 500`, `flushIntervalMs: 10_000`,
  `concurrency: 20`, `maxInstances: 3`.
- Élevé (> 100 writes/s/repo) : `batchSize: 500–1000`, `flushIntervalMs: 10_000`,
  `concurrency: 40`, `maxInstances: 5+` — la Storage Write API n'a pas de
  plafond de concurrence par table, vous pouvez donc scaler horizontalement.
  :::

### Multi-Adapter Fan-Out & Isolation des pannes

Vous pouvez synchroniser vos données Firestore vers plusieurs destinations en parallèle (ex : BigQuery pour l'analytique et Meilisearch pour la recherche textuelle) en passant un tableau d'adaptateurs :

```typescript
adapters: [bigQueryAdapter, meilisearchAdapter],
repos: {
  users: {
    adapters: ["bigquery", "meilisearch"], // Diffusé aux deux
  },
  logs: {
    adapters: ["bigquery"], // Uniquement envoyé à BigQuery
  },
}
```

### Isolation totale des pannes

Chaque adaptateur fonctionne avec sa propre file `SyncQueue` isolée et son topic dead-letter dédié (`firestore-sync-users-meilisearch-dlq`). Si Meilisearch est temporairement indisponible, ses batchs en échec sont redirigés vers sa propre DLQ sans bloquer ni ralentir l'insertion dans BigQuery.

## Adaptateur BigQuery

L'adaptateur BigQuery stream les lignes via l'API **BigQuery Storage Write API** en mode **CDC** (Change Data Capture). Plusieurs instances Cloud Function peuvent écrire en parallèle sans plafond de concurrence, c'est ~50 % moins cher que le streaming legacy, et la protection contre l'ordre d'arrivée est conservée car chaque event porte son `__sync_version` comme `_CHANGE_SEQUENCE_NUMBER`.

Le client Storage Write est une **dépendance peer optionnelle** — installez-la dans votre projet :

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
  // Cadence du merge CDC en arrière-plan — voir « À propos de maxStaleness ».
  maxStaleness: "INTERVAL 15 MINUTE",
});
```

L'adaptateur gère :

- Création de tables via DDL avec `PRIMARY KEY ... NOT ENFORCED` et clustering sur la PK (requis par le mode CDC)
- Streaming UPSERTs et DELETEs via le flux par défaut
- Introspection de schéma (pour le health check)
- Migration automatique de colonnes (`addColumns`) avec détection de dérive de type
- Encodage des dates en microsecondes epoch (format attendu par l'API Storage Write)

### Authentification

- **Production (Cloud Run / Cloud Functions)** : authentification automatique via ADC — passez simplement `projectId`
- **Développement local** : lancez `gcloud auth application-default login`
- Le compte de service a besoin du rôle `roles/bigquery.dataEditor`

### À propos de `maxStaleness`

Les écritures CDC atterrissent dans le buffer de changement de BigQuery ; les lignes ne deviennent visibles dans la table de base qu'après un **MERGE** asynchrone. `max_staleness` est le délai max pour ce merge :

- **`INTERVAL 0`** — chaque `SELECT` déclenche un merge synchrone du buffer complet avant de retourner les résultats (ralentit les lectures).
- **`INTERVAL N MINUTE`** — BigQuery exécute le MERGE en arrière-plan au maximum toutes les N minutes (gratuit, ne bloque pas les lectures). La lib utilise **15 minutes** par défaut.

## Adaptateur Meilisearch

L'adaptateur Meilisearch stream les documents Firestore dans des index [Meilisearch](https://www.meilisearch.com/) pour une recherche textuelle instantanée et tolérante aux fautes.

Installez le SDK Meilisearch optionnel :

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

L'adaptateur gère :
- La création automatique des index lors du premier événement avec clé primaire.
- L'application automatique des paramètres d'index (`indexesSettings`).
- Le batching haute performance des documents (`addDocuments`) et des suppressions (`deleteDocuments`).
- Le diagnostic d'état et des statistiques d'index via `/health` et `/config-check`.

## Évolution de schéma

`autoMigrate` ajoute des colonnes lorsque votre schéma Zod gagne des champs. Il ne modifie **jamais** le type d'une colonne existante.

Le worker détecte les dérives de type et lève une `SchemaTypeMismatchError` explicite :

```
Schema drift detected on `posts`: column `view_count` has type STRING in
BigQuery but the current Zod schema maps it to INT64.
```

### Workflow recommandé

Considérez vos schémas Firestore comme **append-only**. Pour changer le type d'un champ :

1. **Renommez le champ dans Zod** (`view_count` → `view_count_v2`). La prochaine migration ajoute la nouvelle colonne.
2. **Rétro-remplissez** avec un job SQL ponctuel : `UPDATE … SET view_count_v2 = CAST(view_count AS INT64)`.
3. **Supprimez l'ancienne colonne** une fois la bascule terminée.

## Admin Sync

L'admin fournit une interface web de monitoring et de gestion.

### Fonctionnalités

| Fonctionnalité   | Flag          | Description                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------- |
| **Health Check** | `healthCheck` | Compare le schéma Zod avec les colonnes SQL et les statistiques d'index Search  |
| **Force Sync**   | `manualSync`  | Re-synchronise l'intégralité d'une collection Firestore vers toutes ses cibles  |
| **Config Check** | `configCheck` | Vérifie les APIs GCP, Meilisearch, topics, tables et permissions IAM            |

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

Le endpoint `/config-check` vérifie votre setup GCP et vos moteurs de recherche :

- **API & tables BigQuery** — activée et accessible ?
- **API & index Meilisearch** — instance joignable et index initialisés ?
- **Topics Pub/Sub** — topics `{topicPrefix}-{repoName}` existants ?

### Force Sync

Déclenché depuis le dashboard ou via `POST /:repoName/force-sync` (HTML ou `Accept: application/json`). Il relit chaque document d'une collection Firestore et le transmet à l'ensemble des adaptateurs configurés pour ce repository.

## Functions générées

`servers.sync(...)` génère ces Cloud Functions :

| Fonction          | Type              | Rôle                                     |
| ----------------- | ----------------- | ---------------------------------------- |
| `{repo}_onSync`   | Trigger Firestore | Trigger unique `onDocumentWritten`       |
| `sync_{repo}`     | Handler PubSub    | Traite les messages et flush vers cibles |
| `adminsync`       | Handler HTTP      | Interface admin (si `admin` configuré)   |

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

Firestore retourne les dates sous forme de `Timestamp`. Passez en `"normalize"` une fois au démarrage de l'app pour convertir tout `Timestamp` en `Date` JavaScript à la lecture :

```typescript
import { setDateHandling } from "@lpdjs/firestore-repo-service";

setDateHandling("normalize");
```

## Adaptateur Sync personnalisé

Implémentez l'interface universelle `SyncAdapter` pour d'autres bases ou moteurs de recherche :

```typescript
import type { SyncAdapter, SyncHealthResult } from "@lpdjs/firestore-repo-service/sync";

class MyCustomAdapter implements SyncAdapter {
  readonly name = "elasticsearch";

  async targetExists(targetName: string): Promise<boolean> {
    return true;
  }

  async upsert(
    targetName: string,
    items: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    // Upsert des documents
  }

  async delete(
    targetName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void> {
    // Suppression des documents
  }

  async ensureTarget(options: {
    targetName: string;
    primaryKey: string;
    schema?: any;
    exclude?: string[];
    columnMap?: Record<string, string>;
  }): Promise<void> {
    // Création automatique de la table ou de l'index
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
