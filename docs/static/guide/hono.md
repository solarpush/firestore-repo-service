# Hono File-Based API Server

A typed, file-based HTTP server built on [Hono](https://hono.dev/), designed
to ship one (or many) **Firebase Cloud Function v2** per logical API. It pairs
a tiny prebuild codegen (`frs gen`) with a typed multi-API registry
(`createApiRegistry`) so you can write Zod-validated routes next to your
business logic and forget about wiring.

## Feature overview

| Feature | Description |
| --- | --- |
| **File-based routing** | Drop a `routes.ts` next to a useCase. The CLI scans the tree at build time and emits a static manifest — zero runtime filesystem access. |
| **Multi-API registry** | `createApiRegistry({ v1, v2, webhooks, ... })` is the single source of truth. Each tag becomes one Cloud Function. |
| **Typed `defineRoute` / `useCaseRoute`** | The `api` field is narrowed to your registered tags. `useCaseRoute(UseCaseClass, meta)` derives `input` / `output` from the useCase's static Zod schemas; `defineRoute({...})` stays available for inline handlers. |
| **Zod validation** | `input` schemas validated automatically (body / query / params). Optional response validation via `validateOutput`. |
| **OpenAPI 3.1** | Auto-generated from the Zod schemas. `/openapi.json` + interactive Scalar UI at `/docs`. |
| **Interceptor + onError** | Single around-style hook per API for envelopes, error mapping, tracing. Plus a Hono-style `onError`. |
| **Middlewares** | Per-API and per-route Hono middlewares with full type propagation. |
| **Typed context** | Augment Hono's `ContextVariableMap` once and `c.get("user")` is fully typed in every handler. |
| **CLI scaffolder** | `frs init` bootstraps `apis.ts` + manifest stub. `frs new` scaffolds a useCase + route + Vitest test (interactive prompts when flags are missing). |
| **One function per API** | `apis.toFunctions(routes, onRequest, { defaults, per })` returns a map ready to spread into your `index.ts`. |

## Install

```bash
npm i @lpdjs/firestore-repo-service hono @hono/node-server zod
npm i -D @asteasolutions/zod-to-openapi
```

The `frs` CLI is exposed via the package's `bin` field.

## Bootstrap a project

```bash
npx frs init
```

The interactive prompt asks for:
- the **domain root** (default `src/domains`),
- the **`apis.ts` location** (default `src/apis.ts`),
- the list of **API tags** to register (default `v1`),
- an optional shared **basePath**.

Pass `--yes` to skip prompts (CI mode), or any of `--root`, `--apis-file`,
`--apis`, `--base-path`, `--force` to override.

After `init` you'll have:

```
src/
├── apis.ts                      ← createApiRegistry(...) + export defineRoute / useCaseRoute
└── domains/
    └── __generated__/routes.ts  ← empty stub (refreshed by `frs gen`)
```

## Wire it in your Cloud Functions entrypoint

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

Each registered API tag produces one Cloud Function whose name matches the key.
URLs end up at `https://<region>-<project>.cloudfunctions.net/v1/...`.

## Configure your APIs (`apis.ts`)

```ts
import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { enrichUser } from "./middlewares/enrich-user.js";

export const apis = createApiRegistry({
  v1: {
    basePath: "/v1",
    middlewares: [enrichUser],
    openapi: {
      info: { title: "Public API", version: "1.0.0" },
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
        // map domain errors → HTTP, rethrow others to onError
        throw err;
      }
    },
    onError: (err, c) => {
      console.error("Unhandled:", err);
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

// Re-export the typed helpers used in every routes.ts.
export const defineRoute = apis.defineRoute;
export const useCaseRoute = apis.useCaseRoute;
```

## Write a route

```bash
npx frs new createPost --domain posts --method post --api v1
```

Generates:

```
src/domains/posts/useCases/createPost/
├── routes.ts        ← maps the useCase to an HTTP endpoint
├── useCase.ts       ← business logic + Zod input/output schemas
└── useCase.test.ts  ← Vitest skeleton
```

The useCase owns its Zod `input` / `output` schemas (as `static` members, the
single source of truth) and the business logic. The shared `services` container
is injected by the `UseCase` base class via the constructor:

```ts
// src/domains/posts/useCases/createPost/useCase.ts
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
    return { id: `${user.id}:${payload.title}` };
  }
}
```

`routes.ts` then wires the useCase into an endpoint with `useCaseRoute` — no
schema duplication, no handler boilerplate:

```ts
// src/domains/posts/useCases/createPost/routes.ts
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(CreatePostUseCase, {
    api: "v1",            // ← typed: "v1" | "webhooks"
    method: "post",
    summary: "Create a post",
    tags: ["posts"],
  }),
]);
```

The URL is derived from the file path: `posts/useCases/createPost` →
`/posts/createPost`. Combined with the `v1` basePath above and the function
name, the final URL is `…/v1/v1/posts/createPost` (or `…/v1/posts/createPost`
if you only set `basePath: "/"`). You can also set `path` explicitly in the
`useCaseRoute` meta.

`frs new` prompts interactively when flags are missing (route name,
domain, method, api, with-usecase, with-test). Pass `--yes` to accept defaults.

### Need full control? Use `defineRoute`

When a route has no useCase (or you want the handler inline), `defineRoute`
takes the schemas + handler directly:

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

### Same endpoint, several APIs

Add more entries to the `defineRoutes([...])` array — each `useCaseRoute`
(or `defineRoute`) is typed independently:

```ts
export default defineRoutes([
  useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
  useCaseRoute(CreatePostUseCase, { api: "v2", method: "post", tags: ["posts"] }),
]);
```

## Refresh the manifest

```bash
npx frs gen --root src/domains
```

Wire it into `package.json` as a prebuild step:

```json
{
  "scripts": {
    "build": "frs gen --root src/domains && tsc -p tsconfig.build.json",
    "build:watch": "tsc -w -p tsconfig.build.json"
  }
}
```

Useful flags: `--out`, `--routes-file`, `--skip`, `--casing kebab`, `--ext .js`,
`--exclude`, `--silent`.

## Typing `c.get("user")` etc.

Augment Hono's variable map once (anywhere in your project):

```ts
// src/types/hono.d.ts
import "hono";
declare module "hono" {
  interface ContextVariableMap {
    user: { id: string; name: string; email: string };
  }
}
```

Then inside any handler / middleware, `c.get("user")` is fully typed — no
generics to plumb through.

## Services & dependency injection

Declare every singleton your project needs — repositories, SDK clients,
loggers — **once** in a global container and let the server inject it into
every handler, interceptor, cron job, trigger or test.

### Why

Without DI, every route has to `new MyUseCase()` and forward `c` so the
useCase can read `c.get("user")`. That's boilerplate-heavy and couples
your business code to Hono.

With the built-in container:

- Each service is instantiated **lazily** on first access and cached for
  the process lifetime — ideal for Cloud Functions cold-start.
- Inter-service dependencies are inferred by destructuring the factory
  argument — no manual wiring.
- A built-in `ctx` service exposes the current request's Hono `Context`
  via `AsyncLocalStorage`, so useCases can read `this.services.ctx.c.get("user")`
  without ever receiving `c` as a parameter.

### Declare the container (`src/services.ts`)

The container holds **shared infrastructure only** — SPIs, repositories,
SDK clients, loggers. UseCases live *outside* the container: they `extend`
the `UseCase` base class and receive the whole `services` container through
the constructor (injected for you by `useCaseRoute`). That boundary keeps
`Services` free of any reference back to itself (no circular type alias) and
makes useCases trivial to unit-test with hand-rolled fakes.

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

> **Two provider forms:** factory `({ ctx, db }) => new PostRepo(db)`
> (recommended, deps explicit) or class `postRepo: PostRepo` (auto-injects
> the full proxy). Only use the class form for SPIs that don't import
> `Services`, otherwise TypeScript will emit *"type alias refers to itself
> circularly"* and infer `any`.

### Wire it into the registry (`src/apis.ts`)

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

### Use services in a route

`useCaseRoute` wires the useCase to the endpoint and injects the shared
`services` container automatically — the handler is generated for you:

```ts
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(CreatePostUseCase, { api: "v1", method: "post", tags: ["posts"] }),
]);
```

Inside `defineRoute` (inline handlers) the same `services` proxy is available
on the handler context if you ever need it directly:

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

### Read `this.services` inside a useCase

A useCase `extends UseCase<typeof input, typeof output, Services>`: the base
class injects the **shared `services` container** via the constructor and the
static schemas drive the typing of `execute`. Read deps through
`this.services` — never store `Services` as a hand-written field type.

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

### Reuse services outside HTTP (cron, triggers, tests)

`services.ctx.c` throws when accessed outside a request. Wrap non-HTTP
code paths in `withRequestContext` to supply a synthetic context, then
instantiate the useCase with the shared `services` container:

```ts
import { withRequestContext } from "@lpdjs/firestore-repo-service/servers/hono";
import { services } from "./services.js";
import { CreatePostUseCase } from "./domains/posts/useCases/createPost/useCase.js";

export const dailyTask = onSchedule("every 24 hours", async () => {
  await withRequestContext({ c: fakeContext() }, async () => {
    await new CreatePostUseCase(services).execute({ title: "daily digest" });
  });
});
```

In Vitest the useCase is just a class — no `withRequestContext` needed,
inject a hand-rolled `services` fake:

```ts
import { CreatePostUseCase } from "./useCase.js";
import type { Services } from "../../../../services.js";

it("creates a post", async () => {
  const services = {
    ctx: { c: { get: () => ({ id: "u1" }) } },
    postRepo: { create: async (p: any) => ({ id: "p1", ...p }) },
  } as unknown as Services;

  const uc = new CreatePostUseCase(services);
  expect((await uc.execute({ title: "hello" })).id).toBe("p1");
});
```

### Async resources — lazy connections

Don't make factories `async` — they're sync by design. Instead, lazy-load
async resources inside the service:

```ts
export class BigQueryService {
  private _client: BigQuery | undefined;
  get client(): BigQuery {
    return (this._client ??= new BigQuery({ projectId: "..." }));
  }
}
```

### Scaffold a service

```bash
frs add service postRepo
```

Creates `src/services/postRepo.ts` and inserts an `import` + a factory
line into `src/services.ts`. Pass `--services-file` / `--services-dir` if
your layout differs.

## OpenAPI

When `openapi.info` is set on an API, the server exposes:

- **`/<basePath>/openapi.json`** — the spec.
- **`/<basePath>/docs`** — interactive [Scalar](https://scalar.com/) UI.

The UI's `data-url` is computed as a relative path so it works behind
Firebase emulator's prefix rewriting and reverse proxies.

Because `@asteasolutions/zod-to-openapi` requires Zod to be patched first, the
server calls `extendZodWithOpenApi(z)` automatically (idempotent) — your raw
Zod schemas are picked up without ceremony.

## CLI reference

| Command | Purpose |
| --- | --- |
| `frs init` | Bootstrap `apis.ts` + an empty manifest stub. Interactive unless `--yes`. |
| `frs gen --root <dir>` | Scan `<dir>` for `routes.ts` files and emit `__generated__/routes.ts`. |
| `frs new <name> --domain <d>` | Scaffold a useCase + route + Vitest test. Prompts when flags are missing. |
| `frs add service <name>` | Scaffold a service file and register it in `services.ts`. |

Run `frs help` for the full flag list.

### `.frsrc.json` — shared config

`frs init` writes a `.frsrc.json` at the project root so sibling commands can
reuse the resolved layout instead of repeating flags:

```json
{
  "root": "src/domains",
  "apisFile": "src/apis.ts",
  "servicesFile": "src/services.ts",
  "apis": ["v1"]
}
```

Every command reads this file and resolves each value with the precedence
**flag → `.frsrc.json` → built-in default** — a flag is only applied when it is
explicitly passed, otherwise the config value (if any) wins, then the default.

| Key | Type | Used by |
| --- | --- | --- |
| `root` | string | `gen` (`--root` becomes optional), `new` |
| `out` | string | `gen` (output file) |
| `apis` | string[] | `new` (first entry is the default `--api`) |
| `useCaseFolder` | string | `new` |
| `apisFile` / `servicesFile` / `servicesDir` | string | `add service` |

The file is optional: if it is missing or contains invalid JSON it is ignored
silently. You can also edit it by hand.

## Programmatic API (escape hatches)

The barrel `@lpdjs/firestore-repo-service/servers/hono` also exports:

- `HonoServer<TEnv>` — the underlying server class (use directly for
  custom mounts or unit tests).
- `apis.serverFor(tag, routes)` — get the `HonoServer` for a specific API.
- `buildOpenApiDocument(routes, options)` / `renderDocsHtml(...)` — generate
  the spec / UI HTML outside an HTTP context (e.g. in build scripts).
- Codegen primitives: `scanRoutes`, `generateRoutesManifest`,
  `generateFromRoot`, `derivePath`, `toImportSpecifier` — for users who want
  to bypass the CLI and integrate directly into their own pipeline.
- `ValidationError` — instance check inside your interceptor when you want
  to translate Zod failures into your own error envelope.
