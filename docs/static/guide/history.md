# Change History

Opt-in, per-repo change-history capture using Firestore triggers, with a typed read API on the configured repository.

- **Reliable** – triggers fire for every write (back-office, scripts, admin console, other services).
- **Typed** – meta fields are declared inside the repo config and validated against the model.
- **Backward compatible** – the read API normalises both the new v2 schema (1 doc per update) and a legacy v1 schema (1 doc per modified field) into a single shape.

## Architecture

```
Firestore write ──► onDocumentWritten trigger ──► history subcollection
                          (diff + meta)            ({path}/{id}/history/{historyId})

repo.history.list(...)  ◄── normalises v1 + v2 ──── unified HistoryEntry<T>
```

History documents are stored in a subcollection of the entity (default `history`). Each repo opts in independently.

## Quick Start

### 1. Enable history on a repo

```typescript
import { createRepositoryConfig } from "@lpdjs/firestore-repo-service";
import { residenceSchema } from "./schemas";

export const residenceRepoConfig = createRepositoryConfig(residenceSchema)({
  path: "residences",
  documentKey: "id",
  // ... other config ...
  history: {
    enabled: true,
    // subcollection: "history",          // default
    meta: {
      // each entry maps a meta key to a model field — must exist on the model
      userId:    "updatedBy",
      userEmail: "updatedByEmail",
      reason:    "changeReason",
      comment:   "changeComment",
      // free-form extras: copied as-is to meta.extras
      extras:    ["source"],
    },
    // diff scope
    // include: ["name", "address"],      // if set, only these fields are diffed
    exclude: ["lastSeenAt"],              // never tracked
    // ttl: { field: "expiresAt", days: 365 },
  },
});
```

> Meta fields are auto-excluded from the diff (so `updatedBy` flipping won't appear as its own change). The repo type uses `keyof Model`, so a typo on a meta field fails at compile time.

### 2. Wire the triggers (Cloud Functions entry point)

```typescript
import { createHistoryTriggers } from "@lpdjs/firestore-repo-service/history";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import { repos } from "./repos";

const triggers = createHistoryTriggers(repos, {
  deps: { firestoreTriggers },
  // optional global defaults applied to every history-enabled repo
  defaults: {
    ttl: { field: "expiresAt", days: 365 },
  },
  // optional per-repo overrides
  repos: {
    residences: { exclude: ["internalState"] },
  },
});

// One trigger is generated per history-enabled repo, named `{repoName}_onHistory`.
export const { residences_onHistory, prevention_workshops_onHistory } = triggers;
```

For `collectionGroup` repos, set `triggerPath` in the per-repo override (same constraint as sync triggers).

### 3. Read history from your code

```typescript
const entries = await repo.residences.history.list("residence_123", {
  limit: 50,
  direction: "desc",
  fields: ["name", "address"],   // optional filter
  operations: ["update"],         // optional filter
});

for (const entry of entries) {
  console.log(entry.historySetAt.toDate(), entry.meta.userId, entry.operation);
  for (const [field, change] of Object.entries(entry.changes)) {
    console.log(`  ${field}: ${change.oldValue} → ${change.newValue}`);
  }
}
```

For deeper subcollections, pass parent path segments before the docId, just like the rest of the repo API.

## Stored schema (v2)

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
  "expiresAt": Timestamp   // only when ttl is configured
}
```

## Read API

| Method | Description |
|---|---|
| `history.list(docId, opts?)` | Normalised entries (v1 + v2). Real Firestore pagination via `cursor`/`limit`. |
| `history.raw(docId, opts?)` | Raw documents, no normalisation — escape hatch. |
| `history.byField(docId, field, opts?)` | Convenience filter on a specific field. |
| `history.byOperation(docId, operation, opts?)` | Filter by `create` / `update` / `delete`. |
| `history.recordManual(docId, payload)` | Synchronous capture (bypasses trigger). Use sparingly. |

The unified `HistoryEntry<Model>`:

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

History grows linearly with writes. Set `history.ttl: { field: "expiresAt", days: 365 }` to add a Timestamp on every doc, then enable a Firestore TTL policy on that field once via the gcloud CLI or console:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=history --enable-ttl
```

## Backward compatibility (v1)

If your project already writes the legacy v1 schema (1 doc per field, top-level `field`/`changes`/`historyUserId`), the reader detects it and:

- Wraps each v1 doc into a 1-field unified entry.
- Groups consecutive v1 docs sharing the same `historySetAt` (±5 ms by default) and same author into a single logical entry.
- Maps `historyUserId` / `historyUserEmail` / `extraHistoryDetails.{reason,comment}` / `historyDetails` to the unified `meta`.

The trigger always writes v2. v1 is read-only — no migration is required to start using the new API.

## Cost & limits

- 1 extra Firestore write per tracked update (the history doc). Use `exclude` and `include` to keep diffs lean.
- Firestore doc size limit (1 MiB). Large field values are truncated with a `_truncated: true` marker (~700 KiB threshold).
- Triggers run after the write commits — capture is reliable but **not** atomic with the parent write.
