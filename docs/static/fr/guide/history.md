# Historique des changements

Capture d'historique opt-in, par repo, basée sur les triggers Firestore, avec une API de lecture typée exposée directement sur le repository configuré.

- **Fiable** – les triggers se déclenchent pour toute écriture (back-office, scripts, console admin, autres services).
- **Typé** – les champs `meta` sont déclarés dans la config du repo et validés contre le modèle.
- **Rétrocompatible** – l'API de lecture normalise à la fois le nouveau schéma v2 (1 doc par update) et un schéma v1 historique (1 doc par champ modifié) en une seule forme.

## Architecture

```
Écriture Firestore ──► trigger onDocumentWritten ──► sous-collection history
                            (diff + meta)             ({path}/{id}/history/{historyId})

repo.history.list(...)  ◄── normalise v1 + v2 ──── HistoryEntry<T> unifié
```

Les documents d'historique sont stockés dans une sous-collection de l'entité (par défaut `history`). Chaque repo opt-in indépendamment.

## Démarrage rapide

### 1. Activer l'historique sur un repo

```typescript
import { createRepositoryConfig } from "@lpdjs/firestore-repo-service";
import { residenceSchema } from "./schemas";

export const residenceRepoConfig = createRepositoryConfig(residenceSchema)({
  path: "residences",
  documentKey: "id",
  // ... autres options ...
  history: {
    enabled: true,
    // subcollection: "history",          // valeur par défaut
    meta: {
      // chaque entrée mappe une clé meta vers un champ du modèle — doit exister
      userId:    "updatedBy",
      userEmail: "updatedByEmail",
      reason:    "changeReason",
      comment:   "changeComment",
      // extras libres : copiés tels quels dans meta.extras
      extras:    ["source"],
    },
    // périmètre du diff
    // include: ["name", "address"],      // si défini, seuls ces champs sont diffés
    exclude: ["lastSeenAt"],              // jamais tracké
    // ttl: { field: "expiresAt", days: 365 },
  },
});
```

> Les champs `meta` sont automatiquement exclus du diff (donc `updatedBy` qui change n'apparaît pas comme un changement à part). Le type du repo utilise `keyof Model`, donc une faute de frappe sur un champ meta échoue à la compilation.

### 2. Brancher les triggers (entry point Cloud Functions)

Deux approches équivalentes :

#### Via `createServers` (recommandé)

`servers.history()` cohabite avec `servers.api()` / `servers.sync()` et réutilise la même instance `repos`. À noter : l'historique repose sur des triggers Firestore, il n'**hérite donc pas** des `httpsOptions` du serveur API.

```typescript
import { createServers } from "@lpdjs/firestore-repo-service";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import { repos } from "./repos";

const servers = createServers({ repos /* …autres deps */ });

export const historyTriggers = servers.history({
  deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
  defaults: { ttl: { field: "expiresAt", days: 365 } },
  repos: {
    residences: { exclude: ["internalState"] },
  },
});

// Un trigger par repo avec history activé, nommé `{repoName}_onHistory`.
export const { residences_onHistory } = historyTriggers;
```

#### Via la factory standalone

```typescript
import { createHistoryTriggers } from "@lpdjs/firestore-repo-service/history";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import { repos } from "./repos";

const triggers = createHistoryTriggers(repos, {
  deps: { onDocumentWritten: firestoreTriggers.onDocumentWritten },
  defaults: { ttl: { field: "expiresAt", days: 365 } },
});

export const { residences_onHistory } = triggers;
```

Pour les repos `collectionGroup`, définissez `triggerPath` dans l'override par repo (même contrainte que les triggers de sync).

### 3. Lire l'historique depuis votre code

```typescript
const entries = await repos.residences.history!.list("residence_123", {
  limit: 50,
  direction: "desc",
  fields: ["name", "address"],   // filtre optionnel
  operations: ["update"],         // filtre optionnel
});

for (const entry of entries) {
  console.log(entry.historySetAt.toDate(), entry.meta.userId, entry.operation);
  for (const [field, change] of Object.entries(entry.changes)) {
    console.log(`  ${field}: ${change.oldValue} → ${change.newValue}`);
  }
}
```

Pour les sous-collections plus profondes, passez les segments parent avant le `docId`, comme partout dans l'API du repo.

## Intégration Admin UI

Quand un repo a `history.enabled: true`, le serveur admin **automatiquement** :

- Détecte la présence du namespace `repo.history`.
- Affiche un bouton **History** sur chaque ligne de la vue liste.
- Expose une route dédiée `GET /:repoName/:id/history` qui rend la timeline sous forme de tableau (timestamp, badge d'opération, utilisateur, reason/comment, par champ `oldValue → newValue`).

Aucun branchement manuel — dès que vous activez l'historique sur un repo, il apparaît dans l'admin.

## Schéma stocké (v2)

```jsonc
// {collectionPath}/{docId}/history/{historyId}
{
  "schemaVersion": 2,
  "historyDocId": "uuid",
  "historyToObjectId": "residence_123",
  "historySetAt": Timestamp,
  "operation": "create" | "update" | "delete",
  "meta": {
    "userId":    "user_42",
    "userEmail": "...",
    "reason":    "...",
    "comment":   "...",
    "extras":    { "source": "back-office" }
  },
  "changes": {
    "name":    { "oldValue": "A", "newValue": "B", "type": { "old": "string", "new": "string" } },
    "address": { "oldValue": {…}, "newValue": {…}, "type": { "old": "object", "new": "object" } }
  },
  "expiresAt": Timestamp   // uniquement quand ttl est configuré
}
```

## API de lecture

Toutes les méthodes héritent de la signature `documentRef` du repo : pour une collection top-level vous passez `(docId, …)`, pour une sous-collection `(parentId, docId, …)`. `byField` est typé sur `keyof Model`, donc autocomplété.

| Méthode | Description |
|---|---|
| `history.list(docId, opts?)` | Entrées normalisées (v1 + v2). Pagination Firestore réelle via `cursor` / `limit`. |
| `history.raw(docId, opts?)` | Documents bruts, sans normalisation — escape hatch. |
| `history.byField(docId, field, opts?)` | Filtre pratique sur un champ spécifique. |
| `history.byOperation(docId, operation, opts?)` | Filtre par `create` / `update` / `delete`. |
| `history.recordManual(docId, payload)` | Capture synchrone (bypass du trigger). À utiliser avec parcimonie. |

Le `HistoryEntry<Model>` unifié :

```ts
type HistoryEntry<T> = {
  historyDocId: string;
  historyToObjectId: string;
  historySetAt: Timestamp;
  schemaVersion: 1 | 2;
  operation: "create" | "update" | "delete";
  meta: { userId?, userEmail?, reason?, comment?, extras? };
  changes: { [field]: { oldValue, newValue, type: { old, new } } };
};
```

## TTL

L'historique grossit linéairement avec les écritures. Définissez `history.ttl: { field: "expiresAt", days: 365 }` pour ajouter un Timestamp sur chaque doc, puis activez une politique TTL Firestore sur ce champ une seule fois via la CLI gcloud ou la console :

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=history --enable-ttl
```

## Rétrocompatibilité (v1)

Si votre projet écrit déjà l'ancien schéma v1 (1 doc par champ, `field`/`changes`/`historyUserId` au top-level), le reader le détecte et :

- Wrappe chaque doc v1 en une entrée unifiée à 1 champ.
- Regroupe les docs v1 consécutifs partageant le même `historySetAt` (±5 ms par défaut) et le même auteur en une entrée logique unique.
- Mappe `historyUserId` / `historyUserEmail` / `extraHistoryDetails.{reason,comment}` / `historyDetails` vers le `meta` unifié.

Le trigger écrit toujours en v2. Le v1 est read-only — aucune migration n'est requise pour commencer à utiliser la nouvelle API.

## Coût & limites

- 1 écriture Firestore additionnelle par update tracké (le doc d'historique). Utilisez `exclude` et `include` pour garder les diffs légers.
- Limite de taille de doc Firestore (1 MiB). Les valeurs de champ trop grosses sont tronquées avec un marqueur `_truncated: true` (~700 KiB de seuil).
- Les triggers s'exécutent **après** le commit de l'écriture — la capture est fiable mais **pas** atomique avec l'écriture parente.
