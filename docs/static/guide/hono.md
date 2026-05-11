# Hono File-Based API Server

A typed, file-based HTTP server built on [Hono](https://hono.dev/), designed
to ship one (or many) **Firebase Cloud Function v2** per logical API. It pairs
a tiny prebuild codegen (`frs-hono gen`) with a typed multi-API registry
(`createApiRegistry`) so you can write Zod-validated routes next to your
business logic and forget about wiring.

## Feature overview

| Feature | Description |
| --- | --- |
| **File-based routing** | Drop a `routes.ts` next to a useCase. The CLI scans the tree at build time and emits a static manifest — zero runtime filesystem access. |
| **Multi-API registry** | `createApiRegistry({ v1, v2, webhooks, ... })` is the single source of truth. Each tag becomes one Cloud Function. |
| **Typed `defineRoute`** | The `api` field is narrowed to your registered tags. Per-route inference of `input` / `output` / `handler.input`. |
| **Zod validation** | `input` schemas validated automatically (body / query / params). Optional response validation via `validateOutput`. |
| **OpenAPI 3.1** | Auto-generated from the Zod schemas. `/openapi.json` + interactive Scalar UI at `/docs`. |
| **Interceptor + onError** | Single around-style hook per API for envelopes, error mapping, tracing. Plus a Hono-style `onError`. |
| **Middlewares** | Per-API and per-route Hono middlewares with full type propagation. |
| **Typed context** | Augment Hono's `ContextVariableMap` once and `c.get("user")` is fully typed in every handler. |
| **CLI scaffolder** | `frs-hono init` bootstraps `apis.ts` + manifest stub. `frs-hono new` scaffolds a useCase + route + Vitest test (interactive prompts when flags are missing). |
| **One function per API** | `apis.toFunctions(routes, onRequest, { defaults, per })` returns a map ready to spread into your `index.ts`. |

## Install

```bash
npm i @lpdjs/firestore-repo-service hono @hono/node-server zod
npm i -D @asteasolutions/zod-to-openapi
```

The `frs-hono` CLI is exposed via the package's `bin` field.

## Bootstrap a project

```bash
npx frs-hono init
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
├── apis.ts                      ← createApiRegistry(...) + export defineRoute
└── domains/
    └── __generated__/routes.ts  ← empty stub (refreshed by `frs-hono gen`)
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

// Re-export the typed defineRoute helper used in every routes.ts.
export const defineRoute = apis.defineRoute;
```

## Write a route

```bash
npx frs-hono new createPost --domain posts --method post --api v1
```

Generates:

```
src/domains/posts/useCases/createPost/
├── routes.ts        ← Zod schemas + handler
├── useCase.ts       ← pure business logic
└── useCase.test.ts  ← Vitest skeleton
```

```ts
// src/domains/posts/useCases/createPost/routes.ts
import { z } from "zod";
import { defineRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoute({
  api: "v1",                    // ← typed: "v1" | "webhooks"
  method: "post",

  input: z.object({ title: z.string() }),
  output: z.object({ id: z.string() }),

  summary: "Create a post",
  tags: ["posts"],

  handler: async ({ input, c }) => {
    const useCase = new CreatePostUseCase();
    return await useCase.execute(input);
  },
});
```

The URL is derived from the file path: `posts/useCases/createPost` →
`/posts/createPost`. Combined with the `v1` basePath above and the function
name, the final URL is `…/v1/v1/posts/createPost` (or `…/v1/posts/createPost`
if you only set `basePath: "/"`). You can also set `path` explicitly.

`frs-hono new` prompts interactively when flags are missing (route name,
domain, method, api, with-usecase, with-test). Pass `--yes` to accept defaults.

### Same endpoint, several APIs (different schemas)

Export an array of `defineRoute(...)` calls — TS infers each one independently:

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

## Refresh the manifest

```bash
npx frs-hono gen --root src/domains
```

Wire it into `package.json` as a prebuild step:

```json
{
  "scripts": {
    "build": "frs-hono gen --root src/domains && tsc -p tsconfig.build.json",
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
| `frs-hono init` | Bootstrap `apis.ts` + an empty manifest stub. Interactive unless `--yes`. |
| `frs-hono gen --root <dir>` | Scan `<dir>` for `routes.ts` files and emit `__generated__/routes.ts`. |
| `frs-hono new <name> --domain <d>` | Scaffold a useCase + route + Vitest test. Prompts when flags are missing. |

Run `frs-hono help` for the full flag list.

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
