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
| **`defineRoute` / `useCaseRoute` typés** | Le champ `api` est restreint à tes tags enregistrés. `useCaseRoute(UseCaseClass, meta)` dérive `input` / `output` des schémas Zod statiques du useCase ; `defineRoute({...})` reste disponible pour les handlers inline. |
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
├── apis.ts                      ← createApiRegistry(...) + export defineRoute / useCaseRoute
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

// Re-export des helpers typés, utilisés dans chaque routes.ts.
export const defineRoute = apis.defineRoute;
export const useCaseRoute = apis.useCaseRoute;
```

## Écrire une route

```bash
npx frs new createPost --domain posts --method post --api v1
```

Génère :

```
src/domains/posts/useCases/createPost/
├── routes.ts                      ← mappe le useCase vers un endpoint HTTP
├── posts.createPost.useCase.ts    ← logique métier + schémas Zod input/output
└── posts.createPost.useCase.test.ts  ← squelette Vitest
```

Les fichiers useCase / test sont préfixés par `<domain>.<name>` afin que chaque
fichier soit unique dans le projet (pratique pour Ctrl+P / la recherche floue)
au lieu d'une multitude de `useCase.ts` identiques. `routes.ts` garde son nom —
c'est le point d'ancrage scanné par `frs gen`.

Le useCase possède ses schémas Zod `input` / `output` (en membres `static`,
source de vérité unique) et la logique métier. Le container `services` partagé
est injecté par la classe de base `UseCase` via le constructeur :

```ts
// src/domains/posts/useCases/createPost/posts.createPost.useCase.ts
import { z } from "zod";
import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { Services } from "../../../../services.js";

const input = z.object({ title: z.string() });
const output = z.object({ id: z.string() });

export class PostsCreatePostUseCase extends UseCase<typeof input, typeof output, Services> {
  static readonly input = input;
  static readonly output = output;

  async execute(payload: z.infer<typeof input>): Promise<z.infer<typeof output>> {
    const user = this.services.ctx.c.get("user");
    return { id: `${user.id}:${payload.title}` };
  }
}
```

`routes.ts` câble ensuite le useCase vers un endpoint avec `useCaseRoute` —
sans duplication de schéma ni boilerplate de handler :

```ts
// src/domains/posts/useCases/createPost/routes.ts
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { PostsCreatePostUseCase } from "./posts.createPost.useCase.js";

export default defineRoutes([
  useCaseRoute(PostsCreatePostUseCase, {
    api: "v1",            // ← typé : "v1" | "webhooks"
    method: "post",
    summary: "Créer un post",
    tags: ["posts"],
  }),
]);
```

L'URL est dérivée du chemin du fichier : `posts/useCases/createPost` →
`/posts/createPost`. Combinée au `basePath` `v1` ci-dessus et au nom de la
fonction, l'URL finale est `…/v1/v1/posts/createPost` (ou `…/v1/posts/createPost`
si tu mets seulement `basePath: "/"`). Tu peux aussi définir `path` explicitement
dans le meta de `useCaseRoute`.

`frs new` propose des prompts interactifs quand les flags manquent (nom
de route, domain, méthode, api, with-usecase, with-test). Passe `--yes` pour
accepter les défauts.

### Besoin de contrôle total ? Utilise `defineRoute`

Quand une route n'a pas de useCase (ou que tu veux le handler inline),
`defineRoute` prend directement les schémas + le handler :

```ts
import { z } from "zod";
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { defineRoute } from "../../../../apis.js";

export default defineRoutes([
  defineRoute({
    api: "v1",
    method: "post",
    input: z.object({ title: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ input }) => ({ id: input.title }),
  }),
]);
```

### Même endpoint, plusieurs APIs

Ajoute d'autres entrées au tableau `defineRoutes([...])` — chaque
`useCaseRoute` (ou `defineRoute`) est typé indépendamment :

```ts
export default defineRoutes([
  useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
  useCaseRoute(CreatePostUseCase, { api: "v2", method: "post", tags: ["posts"] }),
]);
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
loggers — **une seule fois** dans un container global, et laisse le serveur
les injecter dans chaque handler, interceptor, cron, trigger ou test.

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
  `this.services.ctx.c.get("user")` sans jamais recevoir `c` en paramètre.

### Déclarer le container (`src/services.ts`)

Le container ne contient que de l'**infrastructure partagée** — SPIs,
repositories, clients SDK, loggers. Les useCases vivent *en dehors* du
container : ils `extend` la classe de base `UseCase` et reçoivent tout le
container `services` via le constructeur (injecté pour toi par `useCaseRoute`).
Cette frontière garde `Services` libre de toute référence à lui-même (pas
d'alias circulaire) et rend les useCases triviaux à unit-tester avec des fakes.

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
export const useCaseRoute = apis.useCaseRoute;
```

### Utiliser les services dans une route

`useCaseRoute` câble le useCase vers l'endpoint et injecte automatiquement
le container `services` partagé — le handler est généré pour toi :

```ts
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
]);
```

Dans `defineRoute` (handlers inline), le même proxy `services` est dispo sur
le contexte du handler si tu en as besoin directement :

```ts
defineRoute({
  api: "v1",
  method: "post",
  input: z.object({ title: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async ({ input, services }) =>
    new CreatePostUseCase(services).execute(input),
});
```

### Lire `this.services` dans un useCase

Un useCase `extends UseCase<typeof input, typeof output, Services>` : la classe
de base injecte le **container `services` partagé** via le constructeur, et les
schémas statiques pilotent le typage de `execute`. Accède aux deps via
`this.services` — ne stocke jamais `Services` dans un champ typé à la main.

```ts
import { z } from "zod";
import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { Services } from "../../../../services.js";

const input = z.object({ title: z.string() });
const output = z.object({ id: z.string() });

export class CreatePostUseCase extends UseCase<typeof input, typeof output, Services> {
  static readonly input = input;
  static readonly output = output;

  async execute(payload: z.infer<typeof input>): Promise<z.infer<typeof output>> {
    const user = this.services.ctx.c.get("user");
    return this.services.postRepo.create({ ...payload, authorId: user.id });
  }
}
```

### Réutiliser hors HTTP (cron, triggers, tests)

`services.ctx.c` throw quand on l'accède hors d'une requête. Pour les
flux non-HTTP, enrobe ton appel dans `withRequestContext` avec un
contexte synthétique, puis instancie le useCase avec le container
`services` partagé :

```ts
import { withRequestContext } from "@lpdjs/firestore-repo-service/servers/hono";
import { services } from "./services.js";
import { CreatePostUseCase } from "./domains/posts/useCases/createPost/useCase.js";

export const dailyTask = onSchedule("every 24 hours", async () => {
  await withRequestContext({ c: fakeContext() }, async () => {
    await new CreatePostUseCase(services).execute({ title: "résumé du jour" });
  });
});
```

En Vitest, le useCase est juste une classe — pas besoin de
`withRequestContext`, injecte un fake `services` à la main :

```ts
import { CreatePostUseCase } from "./useCase.js";
import type { Services } from "../../../../services.js";

it("crée un post", async () => {
  const services = {
    ctx: { c: { get: () => ({ id: "u1" }) } },
    postRepo: { create: async (p: any) => ({ id: "p1", ...p }) },
  } as unknown as Services;

  const uc = new CreatePostUseCase(services);
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

### Documenter l'enveloppe & les erreurs de l'interceptor

Par défaut, le spec documente le `output` brut de chaque route. Mais si un
`interceptor` enveloppe les réponses (ex. `{ data, intercepted: true }`), le
payload réel diffère de `output`. Déclare l'enveloppe via la forme
**structurée** de l'interceptor `{ output, errors?, handler }` — le générateur
documente alors ce que le wrapper renvoie réellement :

```ts
// apis.ts
v1: {
  openapi: { info: { title: "API", version: "1.0.0" } },
  interceptor: {
    // factory — `data` reflète le schéma output propre à chaque route dans la doc
    output: (routeOutput) =>
      z.object({ data: routeOutput ?? z.unknown(), intercepted: z.boolean() }),
    // réponses d'erreur déclarées, ajoutées à chaque opération
    errors: {
      400: z.object({ success: z.literal(false), error: z.string() }),
      500: { description: "Erreur interne", schema: z.object({ error: z.string() }) },
    },
    handler: async ({ c, next }) => c.json({ data: await next(), intercepted: true }),
  },
},
```

- `output` accepte un schéma **statique** (même enveloppe pour toutes les routes)
  **ou** une **factory** `(routeOutput) => schema` (enveloppe le `output` propre
  à chaque route, donc `data` reste typé précisément par endpoint).
- les clés d'`errors` sont des codes HTTP ; les valeurs un schéma Zod brut ou
  `{ description?, schema? }`. Elles sont ajoutées à chaque opération.
- la forme fonction (`interceptor: async ({ next }) => …`) marche toujours —
  elle ne produit simplement aucune métadonnée d'enveloppe dans le spec.

> Note : l'interceptor est une fonction opaque au runtime, le package ne peut
> pas inférer sa forme — `output` / `errors` sont le moyen de garder la doc
> synchronisée avec ce que le wrapper renvoie.

### Gestion centralisée des erreurs (`errorHandler`)

Étends le **`BaseErrorHandler`** du package au lieu de répéter un `try/catch`
partout. Il mappe déjà les erreurs internes (`ValidationError`, …) ; surcharge
deux hooks pour brancher tes erreurs métier + ton logger :

- `mapError(ctx)` → mappe ton `AppError` en `Response` (retourne `null` pour
  déléguer) ;
- `logError(ctx)` → log via ton `AppLogger` (exécuté seulement si `mapError` a
  matché).

Passe une instance **par API** pour que chaque API ait sa propre stratégie.

```ts
import {
  BaseErrorHandler,
  type ErrorHandlerContext,
} from "@lpdjs/firestore-repo-service/servers/hono";

class AppErrorHandler extends BaseErrorHandler {
  protected override mapError({ error, c }: ErrorHandlerContext): Response | null {
    if (error instanceof AppError) {
      const locale = c.req.header("accept-language")?.startsWith("fr") ? "fr" : "en";
      return c.json(
        {
          // n'expose le message que si l'erreur est destinée à l'utilisateur
          error: error.userFacing ? error.localizedMessage[locale] : AppError.default(locale),
          errorId: error.errorId,
        },
        error.statusCode,
      );
    }
    return null; // → mapping intégré via super
  }

  protected override logError({ error }: ErrorHandlerContext): void {
    AppLogger.err(error); // log structuré + id de corrélation
  }
}

// apis.ts — par API :
v1: { ..., errorHandler: new AppErrorHandler() },  // user-facing, localisé
v2: { ..., errorHandler: new BaseErrorHandler() }, // défauts seuls, pas de contrainte userFacing
```

- **Auto-appliqué** : les erreurs lancées deviennent de vraies réponses HTTP
  sans boilerplate d'interceptor. Si un interceptor custom relance, le handler
  applique quand même l'`errorHandler`.
- **Injecté** : disponible comme `errorHandler` dans le ctx handler/interceptor
  pour un usage manuel (`errorHandler?.handle({ error, c, route, services })`).
- **Composable** : `mapError` qui retourne `null` délègue au mapping intégré ;
  les erreurs inconnues remontent vers ton `onError` / Hono.
- **Flag `userFacing`** : n'expose `localizedMessage` que si l'erreur est
  destinée au client ; sinon renvoie un message générique pour ne rien divulguer.
- Un `errorHandler` partagé reste possible via `createApiRegistry(configs,
  { services, errorHandler })` ; un `errorHandler` par-API l'emporte.

### Logging structuré (`logger`)

Symétrique à `errorHandler` : étends le **`BaseLogger`** du package (surcharge
l'unique hook `write` pour router vers ton sink — `logger` Firebase, pino, …) et
passe une instance **par API**. Il est injecté dans chaque contexte handler /
interceptor / error-handler comme `logger`.

```ts
import { BaseLogger, type LogSeverity } from "@lpdjs/firestore-repo-service/servers/hono";
import { logger as fnLogger } from "firebase-functions/v2";

class AppLogger extends BaseLogger {
  protected override write(severity: LogSeverity, payload: Record<string, unknown>) {
    fnLogger.write({ severity, ...payload }); // un seul override couvre info/warn/debug/error
  }
}
export const appLogger = new AppLogger();

// apis.ts — par API (ou partagé via createApiRegistry({ services, logger })) :
v1: { ..., logger: appLogger },
```

```ts
// dans un handler / interceptor / errorHandler :
handler: ({ input, logger }) => {
  logger?.info("creating post", { id: input.id });
  return { id: input.id };
}
```

- `BaseLogger.error(err)` renvoie un **id de corrélation** (réutilise
  `err.errorId` s'il existe, sinon en génère un) — logge-le et renvoie-le au
  client.
- Chaque niveau (`info` / `warn` / `debug` / `error`) passe par `write`, donc un
  seul override suffit.
- les useCases ne reçoivent que `services` (pas le `logger` injecté) ; expose la
  même instance via une classe de base projet (`protected readonly logger =
  appLogger`) pour que `this.logger` et le `logger` injecté soient identiques.

### Protéger les endpoints de docs (`docsAuth`)

`openapi.docsAuth` protège **uniquement** l'UI `/docs` et le spec `/openapi.json`
— il ne touche jamais à tes routes API (celles-ci se protègent par-API via
`middlewares` ou par des interceptors par route). Il accepte un `MiddlewareHandler`
Hono ou un tableau, donc tu peux brancher un flow totalement custom ou les
helpers intégrés.

Deux helpers sont fournis par le package :

```ts
import { getAuth } from "firebase-admin/auth";
import {
  firebaseBearerAuth,
  basicAuth,
} from "@lpdjs/firestore-repo-service/servers/hono";

// apis.ts — ID token Firebase (Bearer), avec une politique allow() optionnelle.
v1: {
  openapi: {
    info: { title: "API", version: "1.0.0" },
    docsAuth: firebaseBearerAuth({
      getAuth: () => getAuth(),          // lazy — exécuté après initializeApp()
      allow: (token) => token.admin === true,  // optionnel, défaut : tout user vérifié
    }),
  },
},

// …ou HTTP Basic Auth :
docsAuth: basicAuth({ username: "admin", password: process.env.DOCS_PASSWORD! }),

// …ou un flow totalement custom (n'importe quel middleware Hono) :
docsAuth: async (c, next) => {
  if (c.req.header("x-docs-key") !== process.env.DOCS_KEY) {
    return c.text("Unauthorized", 401);
  }
  return next();
},
```

`firebaseBearerAuth` rejette un token absent/invalide avec `401` et un `allow()`
en échec avec `403` ; le token décodé est stocké sur le contexte
(`c.get("docsUser")` par défaut) pour un usage en aval. `getAuth` est appelé
paresseusement à chaque requête, donc déclarable avant l'exécution de
`initializeApp()`.

## Référence CLI

| Commande | Rôle |
| --- | --- |
| `frs init` | Bootstrap `apis.ts` + stub manifest vide. Interactif sauf `--yes`. |
| `frs gen --root <dir>` | Scanne `<dir>` à la recherche des `routes.ts` et émet `__generated__/routes.ts`. |
| `frs new <name> --domain <d>` | Scaffold un useCase + route + test Vitest. Prompts si flags manquants. |
| `frs add service <name>` | Scaffold un fichier service et l'enregistre dans `services.ts`. |

Lance `frs help` pour la liste complète des flags.

### `.frsrc.json` — config partagée

`frs init` écrit un `.frsrc.json` à la racine du projet pour que les commandes
sœurs réutilisent le layout résolu sans répéter les flags :

```json
{
  "root": "src/domains",
  "apisFile": "src/apis.ts",
  "servicesFile": "src/services.ts",
  "apis": ["v1"]
}
```

Chaque commande lit ce fichier et résout chaque valeur avec la précédence
**flag → `.frsrc.json` → défaut intégré** — un flag n'est appliqué que s'il est
explicitement passé, sinon la valeur de la config (si présente) l'emporte, puis
le défaut.

| Clé | Type | Utilisée par |
| --- | --- | --- |
| `root` | string | `gen` (`--root` devient optionnel), `new` |
| `out` | string | `gen` (fichier de sortie) |
| `apis` | string[] | `new` (le premier élément est le `--api` par défaut) |
| `useCaseFolder` | string | `new` |
| `apisFile` / `servicesFile` / `servicesDir` | string | `add service` |

Le fichier est optionnel : s'il est absent ou contient un JSON invalide, il est
ignoré silencieusement. Tu peux aussi l'éditer à la main.

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
