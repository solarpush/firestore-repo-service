# Architecture du projet

Ce document décrit l'organisation modulaire du code.

## Structure

```
src/
├── shared/              # Code partagé entre modules
│   ├── types.ts        # Types communs (WhereClause, QueryOptions, RepositoryConfig, etc.)
│   └── utils.ts        # Utilitaires (chunkArray, capitalize)
│
├── repositories/        # Gestion des repositories
│   ├── types.ts        # Types spécifiques (ConfiguredRepository, GenerateGetMethods, etc.)
│   └── factory.ts      # Factory pour créer les repositories
│
├── methods/             # Implémentation des méthodes
│   ├── get.ts          # Méthodes get.by* et get.byList
│   ├── query.ts        # Méthodes query.by*, query.by, query.getAll, query.onSnapshot, query.paginate
│   ├── aggregate.ts    # Méthodes d'agrégation (count, sum, average)
│   ├── crud.ts         # CRUD de base (create, set, update, delete)
│   ├── batch.ts        # Opérations batch (transactions atomiques)
│   ├── transaction.ts  # Opérations transactionnelles
│   └── bulk.ts         # Opérations bulk avec BulkWriter
│
├── pagination.ts        # Système de pagination avec curseurs
└── query-builder.ts     # Constructeur de requêtes avancées (OR, auto-splitting)

index.ts                 # Point d'entrée - orchestration uniquement
```

## Responsabilités

### `shared/`

Contient le code réutilisable partagé entre tous les modules :

- **types.ts** : Types fondamentaux utilisés partout
- **utils.ts** : Fonctions utilitaires génériques

### `repositories/`

Gère la création et le typage des repositories :

- **types.ts** : Définitions de types pour les repositories configurés
- **factory.ts** : Factory pattern pour assembler tous les composants

### `methods/`

Chaque fichier implémente un groupe de méthodes spécifique :

- **get.ts** : Récupération de documents uniques
- **query.ts** : Recherche de multiples documents
- **aggregate.ts** : Calculs côté serveur (count, sum, average)
- **crud.ts** : Opérations CRUD de base
- **batch.ts** : Opérations batch (max 500)
- **transaction.ts** : Opérations transactionnelles ACID
- **bulk.ts** : Opérations bulk avec gestion automatique du flushing

### Modules indépendants

- **pagination.ts** : Système complet de pagination avec curseurs et générateurs async
- **query-builder.ts** : Constructeur intelligent avec support OR et auto-splitting (>30 items)

### `index.ts`

Point d'entrée qui :

1. Ré-exporte tous les types publics
2. Exporte les helpers (`createRepositoryConfig`, `createRepositoryMapping`)
3. Orchestre la création des repositories via la factory

## Flux de création d'un repository

```
createRepositoryMapping(db, mapping)
  ↓
RepositoryMapping.getRepository(key)
  ↓
createRepository(db, config) [factory.ts]
  ↓
Assemblage des méthodes :
  - createGetMethods()      [get.ts]
  - createQueryMethods()    [query.ts]
  - createAggregateMethods() [aggregate.ts]
  - createCrudMethods()     [crud.ts]
  - createBatchMethods()    [batch.ts]
  - createTransactionMethods() [transaction.ts]
  - createBulkMethods()     [bulk.ts]
  ↓
ConfiguredRepository<T>
```

## Avantages de cette architecture

1. **Séparation des responsabilités** : Chaque module a un rôle clair
2. **Testabilité** : Chaque module peut être testé isolément
3. **Maintenabilité** : Facile de trouver où modifier une fonctionnalité
4. **Réutilisabilité** : Code partagé dans `shared/`
5. **Extensibilité** : Facile d'ajouter de nouvelles méthodes dans `methods/`
6. **Orchestration claire** : `index.ts` reste simple et lisible

## Exemples de modifications courantes

### Ajouter une nouvelle méthode de query

1. Modifier `src/methods/query.ts`
2. Ajouter au type `ConfiguredRepository` dans `src/repositories/types.ts`

### Ajouter un nouveau type partagé

1. Ajouter dans `src/shared/types.ts`
2. L'exporter depuis `index.ts` si nécessaire

### Modifier le comportement du bulk

1. Modifier uniquement `src/methods/bulk.ts`
2. Aucun autre fichier affecté

### Ajouter une feature complexe (ex: cache)

1. Créer `src/cache/` avec ses propres types
2. Intégrer dans `src/repositories/factory.ts`
3. Exporter depuis `index.ts`
