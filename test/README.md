# Tests avec l'émulateur Firestore

Ce dossier contient les tests utilisant l'émulateur Firestore.

## Installation

Installez Firebase CLI si ce n'est pas déjà fait :

```bash
npm install -g firebase-tools
```

## Lancer les tests

### Option 1 : Mode automatique (recommandé)

Lance l'émulateur et les tests automatiquement :

```bash
bun run test:watch
```

Cette commande :

- 🚀 Démarre l'émulateur Firestore automatiquement
- ⏳ Attend que l'émulateur soit prêt (port 8080)
- 🧪 Lance les tests en mode watch
- 🔄 Relance les tests à chaque modification

### Option 2 : Mode manuel (deux terminaux)

**Terminal 1 - Démarrer l'émulateur :**

```bash
bun run emulator
# ou avec les functions
bun run emulatorf
```

**Terminal 2 - Lancer les tests :**

```bash
# Tests une fois
bun run test

# Tests en mode watch
bun test test/repo.test.ts --watch
```

## Endpoints de l'émulateur

- **Firestore** : `localhost:8080`
- **UI** : `http://localhost:4000`
- **Functions** (si activé) : `localhost:5001`

## Scripts disponibles

| Commande             | Description                                 |
| -------------------- | ------------------------------------------- |
| `bun run test`       | Lance les tests une fois (émulateur requis) |
| `bun run test:watch` | Lance l'émulateur + tests en mode watch     |
| `bun run emulator`   | Démarre l'émulateur Firestore seul          |
| `bun run emulatorf`  | Démarre l'émulateur avec Functions          |

## Configuration

La configuration de l'émulateur se trouve dans `firebase.json` :

```json
{
  "emulators": {
    "firestore": {
      "port": 8080
    },
    "functions": {
      "port": 5001
    },
    "ui": {
      "enabled": true,
      "port": 4000
    }
  }
}
```

## Tests disponibles

Le fichier `repo.test.ts` teste toutes les fonctionnalités avec 34+ tests :

### CRUD Operations

- ✅ Create (documents avec ID auto-généré)
- ✅ Set (créer/remplacer avec ID spécifique)
- ✅ Update (mise à jour partielle)
- ✅ Delete (suppression de documents)

### Get Operations

- ✅ Get by foreign key (docId, email, etc.)
- ✅ Get with DocumentSnapshot
- ✅ Get by list of values
- ✅ GetAll (récupérer tous les documents)

### Query Operations

- ✅ Query by query keys
- ✅ Query avec filtres where
- ✅ Query avec orderBy
- ✅ Query avec limit
- ✅ Query avec OR conditions

### Advanced Operations

- ✅ Batch operations (set, update, delete)
- ✅ Bulk operations (pour grands volumes)
- ✅ Subcollections support
- ✅ Relations & Populate
- ✅ Populate avec select (champs spécifiques)
- ✅ Aggregations (count, sum, average)
- ✅ Transactions
- ✅ Collection Groups

## Aucun projet Firebase nécessaire

L'émulateur fonctionne sans projet Firebase réel. Il utilise `projectId: "demo-no-project"` qui est suffisant pour les tests locaux.
