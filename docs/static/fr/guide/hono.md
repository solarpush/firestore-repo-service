# Serveur API Hono basé sur les fichiers

Un serveur HTTP typé, basé sur les fichiers, construit sur [Hono](https://hono.dev/),
conçu pour exposer une (ou plusieurs) **Cloud Function Firebase v2** par API
logique. Il combine un petit codegen prebuild (`frs-hono gen`) et un registre
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
| **Scaffolder CLI** | `frs-hono init` bootstrappe `apis.ts` + le stub du manifest. `frs-hono new` crée un useCase + route + test Vitest (questions interactives si flags manquants). |
| **Une fonction par API** | `apis.toFunctions(routes, onRequest, { defaults, per })` retourne une map prête à spread dans `index.ts`. |

## Installation

```bash
npm i @lpdjs/firestore-repo-service hono @hono/node-server zod
npm i -D @asteasolutions/zod-to-openapi
```

La CLI `frs-hono` est exposée via le champ `bin` du package.

## Bootstrap d'un projet

```bash
npx frs-hono init
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
    └── __generated__/routes.ts  ← stub vide (rafraîchi par `frs-hono gen`)
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
npx frs-hono new createPost --domain posts --method post --api v1
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

`frs-hono new` propose des prompts interactifs quand les flags manquent (nom
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
npx frs-hono gen --root src/domains
```

À wirer dans `package.json` comme étape prebuild :

```json
{
  "scripts": {
    "build": "frs-hono gen --root src/domains && tsc -p tsconfig.build.json",
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
| `frs-hono init` | Bootstrap `apis.ts` + stub manifest vide. Interactif sauf `--yes`. |
| `frs-hono gen --root <dir>` | Scanne `<dir>` à la recherche des `routes.ts` et émet `__generated__/routes.ts`. |
| `frs-hono new <name> --domain <d>` | Scaffold un useCase + route + test Vitest. Prompts si flags manquants. |

Lance `frs-hono help` pour la liste complète des flags.

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
