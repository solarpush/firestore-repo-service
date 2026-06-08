# Serveur API Hono basé sur les fichiers

Un serveur HTTP typé, basé sur les fichiers, construit sur [Hono](https://hono.dev/),
conçu pour exposer une (ou plusieurs) **Cloud Function Firebase v2** par API
logique. Il combine un petit codegen prebuild (`frs gen`) et un registre
multi-API typé (`createApiRegistry`) pour écrire des routes validées par Zod
juste à côté de la logique métier — sans plomberie.

## Vue d'ensemble des fonctionnalités

| Fonctionnalité | Description |
| --- | --- |
| **Routing par fichier** | Pose un `routes.ts` à côté d'un useCase. La CLI scanne l'arbre au build et émet un manifest statique — zéro accès filesystem au runtime. |
| **Registre multi-API** | `createApiRegistry({ v1, v2, webhooks, ... })` est la source unique de vérité. Chaque tag devient une Cloud Function. |
| **`defineRoute` typé** | Le champ `api` est restreint à tes tags enregistrés. Inférence par-route de `input` / `output` / `handler.input`. |
| **Validation Zod** | Les schémas `input` sont validés automatiquement (body / query / params). Validation optionnelle de la réponse via `validateOutput`. |
| **OpenAPI 3.1** | Auto-généré depuis les schémas Zod. `/openapi.json` + UI Scalar interactive sur `/docs`. |
| **Interceptor + onError** | Hook around-style unique par API pour les enveloppes, le mapping d'erreurs, le tracing. Plus un `onError` style Hono. |
| **Middlewares** | Middlewares Hono par API et par route avec propagation de types. |
| **Contexte typé** | Augmente une fois la `ContextVariableMap` de Hono et `c.get("user")` est entièrement typé dans chaque handler. |
| **Scaffolder CLI** | `frs init` bootstrappe `apis.ts` + le stub du manifest. `frs new` crée un useCase + route + test Vitest (questions interactives si flags manquants). |
| **Une fonction par API** | `apis.toFunctions(routes, onRequest, { defaults, per })` retourne une map prête à spread dans `index.ts`. |

## Installation

```bash
npm i @lpdjs/firestore-repo-service hono @hono/node-server zod
npm i -D @asteasolutions/zod-to-openapi
```

La CLI `frs` est exposée via le champ `bin` du package.

## Bootstrap d'un projet

```bash
npx frs init
```

Le prompt interactif demande :
- la **racine des domaines** (défaut `src/domains`),
- l'**emplacement de `apis.ts`** (défaut `src/apis.ts`),
- la liste des **tags d'API** à enregistrer (défaut `v1`),
- un **basePath** partagé optionnel.

Passe `--yes` pour skipper les prompts (mode CI), ou `--root`, `--apis-file`,
`--apis`, `--base-path`, `--force` pour surcharger.

Après `init` :

```
src/
├── apis.ts                      ← createApiRegistry(...) + export defineRoute
└── domains/
    └── __generated__/routes.ts  ← stub vide (rafraîchi par `frs gen`)
```

## Wirer dans l'entrypoint Cloud Functions

```ts
// src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { apis } from "./apis.js";
import { routes } from "./domains/__generated__/routes.js";

export const { v1, v2 } = apis.toFunctions(routes, onRequest, {
  defaults: { region: "us-central1", invoker: "public" },
  per: {
    v2: { memory: "512MiB" },
  },
});
```

Chaque tag d'API enregistré produit une Cloud Function dont le nom matche la
clé. Les URLs aboutissent à `https://<region>-<project>.cloudfunctions.net/v1/...`.

## Configurer tes APIs (`apis.ts`)

```ts
import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { enrichUser } from "./middlewares/enrich-user.js";

export const apis = createApiRegistry({
  v1: {
    basePath: "/v1",
    middlewares: [enrichUser],
    openapi: {
      info: { title: "API publique", version: "1.0.0" },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      security: [{ bearerAuth: [] }],
    },
    interceptor: async ({ next, c }) => {
      try {
        const data = await next();
        return c.json({ success: true, data, error: null });
      } catch (err) {
        // map les erreurs métier → HTTP, relance les autres vers onError
        throw err;
      }
    },
    onError: (err, c) => {
      console.error("Erreur non gérée :", err);
      return c.json({ error: "Internal Server Error" }, 500);
    },
    validateOutput: process.env["NODE_ENV"] !== "production",
    verbose: process.env["NODE_ENV"] !== "production",
  },
  webhooks: {
    basePath: "/hooks",
    openapi: { info: { title: "Webhooks", version: "1.0.0" } },
  },
});

// Re-export du helper defineRoute typé, utilisé dans chaque routes.ts.
export const defineRoute = apis.defineRoute;
```

## Écrire une route

```bash
npx frs new createPost --domain posts --method post --api v1
```

Génère :

```
src/domains/posts/useCases/createPost/
├── routes.ts        ← schémas Zod + handler
├── useCase.ts       ← logique métier pure
└── useCase.test.ts  ← squelette Vitest
```

```ts
// src/domains/posts/useCases/createPost/routes.ts
import { z } from "zod";
import { defineRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoute({
  api: "v1",                    // ← typé : "v1" | "webhooks"
  method: "post",

  input: z.object({ title: z.string() }),
  output: z.object({ id: z.string() }),

  summary: "Créer un post",
  tags: ["posts"],

  handler: async ({ input, c }) => {
    const useCase = new CreatePostUseCase();
    return await useCase.execute(input);
  },
});
```

L'URL est dérivée du chemin du fichier : `posts/useCases/createPost` →
`/posts/createPost`. Combinée au `basePath` `v1` ci-dessus et au nom de la
fonction, l'URL finale est `…/v1/v1/posts/createPost` (ou `…/v1/posts/createPost`
si tu mets seulement `basePath: "/"`). Tu peux aussi définir `path` explicitement.

`frs new` propose des prompts interactifs quand les flags manquent (nom
de route, domain, méthode, api, with-usecase, with-test). Passe `--yes` pour
accepter les défauts.

### Même endpoint, plusieurs APIs (schémas différents)

Exporte un tableau de `defineRoute(...)` — TS infère chacun indépendamment :

```ts
export default [
  defineRoute({
    api: "v1",
    method: "post",
    input: z.object({ title: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ input }) => ({ id: input.title }),
  }),
  defineRoute({
    api: "v2",
    method: "post",
    input: z.object({ title: z.string(), slug: z.string() }),
    output: z.object({ id: z.string(), slug: z.string() }),
    handler: async ({ input }) => ({ id: input.title, slug: input.slug }),
  }),
];
```

## Rafraîchir le manifest

```bash
npx frs gen --root src/domains
```

À wirer dans `package.json` comme étape prebuild :

```json
{
  "scripts": {
    "build": "frs gen --root src/domains && tsc -p tsconfig.build.json",
    "build:watch": "tsc -w -p tsconfig.build.json"
  }
}
```

Flags utiles : `--out`, `--routes-file`, `--skip`, `--casing kebab`, `--ext .js`,
`--exclude`, `--silent`.

## Typer `c.get("user")` etc.

Augmente une fois la variable map de Hono (n'importe où dans ton projet) :

```ts
// src/types/hono.d.ts
import "hono";
declare module "hono" {
  interface ContextVariableMap {
    user: { id: string; name: string; email: string };
  }
}
```

Ensuite, dans n'importe quel handler / middleware, `c.get("user")` est
entièrement typé — sans génériques à propager.

## Services & injection de dépendances

Déclare tous les singletons de ton projet — repositories, clients SDK,
loggers, useCases — **une seule fois** dans un container global, et
laisse le serveur les injecter dans chaque handler, interceptor, cron,
trigger ou test.

### Pourquoi

Sans DI, chaque route doit faire `new MyUseCase()` puis forwarder `c`
pour que le useCase puisse lire `c.get("user")`. C'est verbeux et ça
couple ta logique métier à Hono.

Avec le container intégré :

- Chaque service est instancié **lazy** au premier accès et caché pour
  toute la durée du process — idéal pour le cold-start Cloud Functions.
- Les dépendances entre services sont inférées en destructurant
  l'argument du factory — zéro câblage manuel.
- Un service `ctx` built-in expose le `Context` Hono de la requête
  courante via `AsyncLocalStorage`, donc tes useCases peuvent lire
  `this.ctx.c.get("user")` sans jamais recevoir `c` en paramètre.

### Déclarer le container (`src/services.ts`)

Le container ne contient que de l'**infrastructure partagée** — SPIs,
repositories, clients SDK, loggers. Les useCases vivent *en dehors* du
container : ils sont instanciés par les routes qui en ont besoin et
reçoivent leurs deps via le constructeur. Cette frontière garde
`Services` libre de toute référence à lui-même (pas d'alias circulaire)
et rend les useCases triviaux à unit-tester avec des fakes.

```ts
import { createServices } from "@lpdjs/firestore-repo-service/servers/hono";
import { PostRepo } from "./domains/posts/PostRepo.js";
import { BigQuery } from "@google-cloud/bigquery";

export const services = createServices({
  postRepo: ({ ctx }) => new PostRepo(ctx),
  bigquery: () => new BigQuery({ projectId: "..." }),
});

export type Services = typeof services;
```

> **Deux formes de providers :** factory `({ ctx, db }) => new PostRepo(db)`
> (recommandée, deps explicites) ou classe `postRepo: PostRepo`
> (auto-injecte le proxy complet). N'utilise la forme classe que pour des
> SPIs qui n'importent pas `Services`, sinon TypeScript émettra
> *"L'alias de type fait référence à lui-même de manière circulaire"* et
> inférera `any`.

### Le brancher dans le registre (`src/apis.ts`)

```ts
import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { services } from "./services.js";

export const apis = createApiRegistry(
  {
    v1: { basePath: "/v1", openapi: { info: { title: "API", version: "1.0.0" } } },
  },
  { services },
);

export const defineRoute = apis.defineRoute;
```

### Utiliser les services dans une route — instancier le useCase à la volée

Le handler reçoit le proxy `services` partagé. Construis le useCase
inline avec les deps dont il a besoin (ou via un petit helper local si
tu l'appelles depuis plusieurs routes).

```ts
import { CreatePostUseCase } from "./useCase.js";

defineRoute({
  api: "v1",
  method: "post",
  input: z.object({ title: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async ({ input, services }) => {
    const uc = new CreatePostUseCase(services.ctx, services.postRepo);
    return uc.execute(input);
  },
});
```

### Écrire un useCase

Le useCase déclare ses deps une par une via des paramètres de
constructeur **typés individuellement** — jamais `Services` en champ, ce
qui créerait un alias circulaire.

```ts
import type { RequestContext } from "@lpdjs/firestore-repo-service/servers/hono";
import type { PostRepo } from "./PostRepo.js";

export class CreatePostUseCase {
  constructor(
    private readonly ctx: RequestContext,
    private readonly posts: PostRepo,
  ) {}

  async execute(input: { title: string }) {
    const user = this.ctx.c.get("user");
    return this.posts.create({ ...input, authorId: user.id });
  }
}
```

### Réutiliser hors HTTP (cron, triggers, tests)

`services.ctx.c` throw quand on l'accède hors d'une requête. Pour les
flux non-HTTP, enrobe ton appel dans `withRequestContext` avec un
contexte synthétique, puis instancie le useCase comme dans une route :

```ts
import { withRequestContext } from "@lpdjs/firestore-repo-service/servers/hono";
import { services } from "./services.js";
import { CreatePostUseCase } from "./domains/posts/useCases/createPost/useCase.js";

export const dailyTask = onSchedule("every 24 hours", async () => {
  await withRequestContext({ c: fakeContext() }, async () => {
    const uc = new CreatePostUseCase(services.ctx, services.postRepo);
    await uc.execute({ title: "résumé du jour" });
  });
});
```

En Vitest, le useCase est juste une classe — pas besoin de
`withRequestContext`, injecte un contexte à la main et des fakes :

```ts
import { CreatePostUseCase } from "./useCase.js";

it("crée un post", async () => {
  const ctx = { c: { get: () => ({ id: "u1" }) } } as any;
  const repo = { create: async (p: any) => ({ id: "p1", ...p }) } as any;
  const uc = new CreatePostUseCase(ctx, repo);
  expect((await uc.execute({ title: "hello" })).id).toBe("p1");
});
```

### Ressources async — connexions lazy

Ne rends pas tes factories `async` — elles sont volontairement sync.
Charge plutôt les ressources async à l'intérieur du service :

```ts
export class BigQueryService {
  private _client: BigQuery | undefined;
  get client(): BigQuery {
    return (this._client ??= new BigQuery({ projectId: "..." }));
  }
}
```

### Scaffolder un service

```bash
frs add service postRepo
```

Crée `src/services/postRepo.ts` et ajoute un `import` + une factory dans
`src/services.ts`. Passe `--services-file` / `--services-dir` si ton
layout diffère.

## OpenAPI

Quand `openapi.info` est défini sur une API, le serveur expose :

- **`/<basePath>/openapi.json`** — le spec.
- **`/<basePath>/docs`** — UI [Scalar](https://scalar.com/) interactive.

Le `data-url` de l'UI est calculé en chemin relatif pour fonctionner derrière
le rewrite de l'émulateur Firebase et les reverse proxies.

Comme `@asteasolutions/zod-to-openapi` exige que Zod soit patché en amont, le
serveur appelle `extendZodWithOpenApi(z)` automatiquement (idempotent) — tes
schémas Zod natifs sont reconnus sans cérémonie.

## Référence CLI

| Commande | Rôle |
| --- | --- |
| `frs init` | Bootstrap `apis.ts` + stub manifest vide. Interactif sauf `--yes`. |
| `frs gen --root <dir>` | Scanne `<dir>` à la recherche des `routes.ts` et émet `__generated__/routes.ts`. |
| `frs new <name> --domain <d>` | Scaffold un useCase + route + test Vitest. Prompts si flags manquants. |
| `frs add service <name>` | Scaffold un fichier service et l'enregistre dans `services.ts`. |

Lance `frs help` pour la liste complète des flags.

## API programmatique (échappatoires)

Le barrel `@lpdjs/firestore-repo-service/servers/hono` expose aussi :

- `HonoServer<TEnv>` — la classe serveur sous-jacente (à utiliser directement
  pour des montages custom ou des tests unitaires).
- `apis.serverFor(tag, routes)` — récupère le `HonoServer` d'une API précise.
- `buildOpenApiDocument(routes, options)` / `renderDocsHtml(...)` — génère le
  spec / le HTML de l'UI hors contexte HTTP (ex. dans un script de build).
- Primitives codegen : `scanRoutes`, `generateRoutesManifest`,
  `generateFromRoot`, `derivePath`, `toImportSpecifier` — pour bypasser la CLI
  et intégrer directement dans ton propre pipeline.
- `ValidationError` — pour les `instanceof` dans ton interceptor quand tu veux
  traduire les échecs Zod dans ton enveloppe d'erreur custom.
