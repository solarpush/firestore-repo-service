# Tests avec l'émulateur Firestore

Ce dossier contient les tests utilisant l'émulateur Firestore.

## Installation

Installez Firebase CLI si ce n'est pas déjà fait :

```bash
npm install -g firebase-tools
```

## Lancer les tests

### 1. Démarrer l'émulateur (dans un terminal)

```bash
bun run emulator
# ou
firebase emulators:start --only firestore
```

L'émulateur démarrera sur :

- Firestore : `localhost:8080`
- UI : `http://localhost:4000`

### 2. Lancer les tests (dans un autre terminal)

```bash
bun run test:emulator
```

## Configuration

La configuration de l'émulateur se trouve dans `firebase.json` :

```json
{
  "emulators": {
    "firestore": {
      "port": 8080
    },
    "ui": {
      "enabled": true,
      "port": 4000
    }
  }
}
```

## Tests disponibles

Le fichier `emulator-test.ts` teste toutes les fonctionnalités :

- ✅ Create (documents avec ID auto-généré)
- ✅ Get (par ID, par email)
- ✅ Update (mise à jour partielle)
- ✅ Query (recherche avec filtres)
- ✅ GetAll (récupérer tous les documents)
- ✅ OnSnapshot (listeners en temps réel)
- ✅ Aggregate (count avec filtres)
- ✅ Delete (suppression de documents)

## Aucun projet Firebase nécessaire

L'émulateur fonctionne sans projet Firebase réel. Il utilise `projectId: "demo-project"` qui est suffisant pour les tests locaux.
