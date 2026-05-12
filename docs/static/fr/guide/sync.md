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

> Le `onRequest` partagé est automatiquement transmis à l'admin sync — la Cloud Function `adminsync` est donc générée pour vous. Passez explicitement `admin.onRequest` uniquement pour le surcharger.

## Configuration

### `createServers(repos).sync(config)`

Le wrapper unifié qui crée les triggers, les workers et le serveur admin optionnel (à partir du registre déjà lié à `createServers`).

| Option            | Type                   | Défaut             | Description                                                |
| ----------------- | ---------------------- | ------------------ | ---------------------------------------------------------- |
| `deps`            | `SyncDeps`             | requis             | Dépendances Firebase Functions + PubSub                    |
| `adapter`         | `SqlAdapter`           | requis             | Adaptateur SQL (ex: `BigQueryAdapter`)                     |
| `topicPrefix`     | `string`               | `"firestore-sync"` | Préfixe des topics Pub/Sub                                 |
| `batchSize`       | `number`               | `100`              | Nombre max de lignes par flush                             |
| `flushIntervalMs` | `number`               | `5000`             | Intervalle de flush en ms                                  |
| `autoMigrate`     | `boolean`              | `false`            | Créer/migrer les tables automatiquement                    |
| `workerOptions`   | `SyncWorkerOptions`    | —                  | Options CF v2 du worker (`concurrency`, `maxInstances`, …) |
| `admin`           | `adminsyncConfig`      | —                  | Configuration optionnelle de l'admin                       |
| `repos`           | `TypedRepoSyncConfigs` | —                  | Surcharges par repo                                        |

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

## Protection contre la livraison désordonnée

Pub/Sub **ne garantit pas** l'ordre des messages, et Cloud Functions v2 n'expose
volontairement aucun moyen d'activer `enableMessageOrdering` sur la subscription push
auto-créée derrière `onMessagePublished`. Pour la sync Firestore, cela signifierait que
des écritures rapides successives sur le même document (`create` puis `update`) puissent
être flush vers SQL dans le désordre, laissant des données obsolètes.

La librairie gère ça **au niveau applicatif** :

1. Chaque `SyncEvent` publié par un trigger contient un champ `version` — le
   `Date.now()` au moment du publish, en millisecondes.
2. Le worker estampille la ligne avec cette valeur dans une colonne cachée
   `__sync_version` (ajoutée automatiquement par `zodSchemaToColumns` et `autoMigrate`).
3. Le `MERGE` BigQuery ne met à jour la ligne que si la version entrante est strictement
   supérieure à celle stockée :

   ```sql
   WHEN MATCHED
     AND (T.`__sync_version` IS NULL OR S.`__sync_version` > T.`__sync_version`)
   THEN UPDATE SET …
   ```

4. Au sein d'un même batch, la queue dédoublonne les upserts par `docId` en ne gardant
   que la ligne avec la `version` la plus haute — ce qui évite l'erreur BigQuery
   _"UPDATE/MERGE must match at most one source row for each target row"_ quand
   plusieurs updates du même document sont flush ensemble.

**Aucune configuration nécessaire.** Les updates désordonnés sont silencieusement
écartés, le plus récent gagne toujours. Les tables existantes reçoivent la colonne
`__sync_version` au prochain démarrage du worker quand `autoMigrate: true`.

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
parallèle attend le même `MERGE` BigQuery en cours et ne résout qu'une fois
son event réellement écrit. C'est ce qui rend le `await q.flush()` final du
handler safe — PubSub ack uniquement après confirmation BigQuery, donc un
crash d'instance avant flush ne perd jamais d'event.

::: warning Quota DML BigQuery & erreurs serialize-access

BigQuery autorise seulement ~**2 DML concurrents par table**. Au-delà, tu
reçois `Could not serialize access to table … due to concurrent update`
(HTTP 400, `invalidQuery`). Ça arrive dès que **deux instances Cloud
Function** flush la même table en même temps.

La librairie atténue ça avec un retry exponentiel jitter dans
`BigQueryAdapter` (10 tentatives, base 500 ms), mais la seule façon de
**l'éliminer** c'est de sérialiser les MERGE par table. La recette la plus
fiable :

- `maxInstances: 1` par repo (un seul writer par table BigQuery).
- `concurrency: 5–10` pour le parallélisme intra-instance (toujours safe —
  `SyncQueue` sérialise les flushes dans le process).
- `batchSize` plus grand (500–1000) et `flushIntervalMs` plus long (10–15 s)
  pour amortir le coût des DML.

Pour scaler horizontalement au-delà d'une instance, migrer vers la BigQuery
Storage Write API (pas de sérialisation DML).
:::

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

- Faible trafic (< 10 writes/s/repo) : valeurs par défaut OK
  (`maxInstances: 1`, `concurrency: 1`).
- Moyen (10-100 writes/s/repo) : `batchSize: 500`, `flushIntervalMs: 10_000`,
  `concurrency: 5`, `maxInstances: 1`.
- Élevé (> 100 writes/s/repo) : garder `maxInstances: 1` par repo et migrer
  vers la BigQuery Storage Write API (pas de sérialisation DML par table).
  :::

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
    configCheck: true,
  },
}
```

### Auth Firebase (unifiée avec admin / crud)

Le champ `auth` accepte aussi une `AuthExtension` retournée par
`firebaseAuth({ ... })` — la même que celle utilisée par `servers.admin()` et
`servers.crud()`. La page de connexion inline, les cookies de session et le
callback `allow()` fonctionnent à l'identique :

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

| Champ          | Description                                                   |
| -------------- | ------------------------------------------------------------- |
| `processed`    | Total de documents lus depuis Firestore                       |
| `published`    | Publishes Pub/Sub réussis                                     |
| `errors`       | Nombre de documents qui n'ont pas pu être publiés             |
| `errorSamples` | 5 premières erreurs (`{ docId, message }`) pour diagnostiquer |

Les erreurs sont également loggées via
`console.error('[ForceSync:{repo}] doc={docId} failed:', e)` pour apparaître dans
Cloud Logging.

## Functions générées

`servers.sync(...)` génère ces Cloud Functions :

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

| Mode          | Comportement                                                  |
| ------------- | ------------------------------------------------------------- |
| `"preserve"`  | (défaut) Les `Timestamp` Firestore sont retournés tels quels  |
| `"normalize"` | Convertit récursivement `Timestamp` → `Date` à chaque lecture |

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
