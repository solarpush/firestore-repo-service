#!/usr/bin/env node
/**
 * `frs` CLI — codegen + scaffolder for the file-based Hono server.
 *
 * Usage:
 *   frs init                        # interactive project bootstrap
 *   frs gen  --root src/domains
 *   frs new  createPost --domain posts --method post
 *
 * Designed to be a **prebuild step** (e.g. wired into `npm run build`).
 * Outputs a manifest with static imports — no runtime filesystem scanning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { generateRoutesManifest } from "./codegen/generator";
import { DEFAULT_DERIVE, type PathDeriveOptions } from "./codegen/path-utils";
import {
  DEFAULT_SCANNER,
  scanRoutes,
  type ScannerOptions,
} from "./codegen/scanner";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

const CONFIG_FILE = ".frsrc.json";

interface FrsConfig {
  root?: string;
  apisFile?: string;
  servicesFile?: string;
  servicesDir?: string;
  apis?: string[];
  out?: string;
  useCaseFolder?: string;
  /**
   * Paths to the scaffolded ORM server files (`frs add server <type>`).
   * `rootPath` is the shared `servers.ts` (createServers); `reposPath` is the
   * repository registry; `admin`/`crud`/`sync` are the per-server files.
   */
  servers?: {
    rootPath?: string;
    reposPath?: string;
    admin?: string;
    crud?: string;
    sync?: string;
  };
}

function readConfig(cwd: string = process.cwd()): FrsConfig {
  const file = resolve(cwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FrsConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: FrsConfig, cwd: string = process.cwd()): string {
  const file = resolve(cwd, CONFIG_FILE);
  const existing = readConfig(cwd);
  const merged: FrsConfig = { ...existing, ...cfg };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return file;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command: command ?? "help", flags };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`frs — Hono file-based codegen

Usage:
  frs init [flags]
  frs gen  [flags]
  frs new  <name> [flags]
  frs add  service <name> [flags]
  frs add  server <admin|crud|sync> [flags]
  frs sdk:spec [flags]
  frs help

Flags (init):
  --root <dir>          Domain root to create (default: src/domains)
  --apis-file <path>    Path to the apis.ts file to create (default: src/apis.ts)
  --services-file <path>
                        Path to the services.ts file to create
                        (default: src/services.ts)
  --apis <list>         Comma-separated API tags to register (default: v1)
  --base-path <prefix>  basePath shared by all APIs (default: derived from tag)
  --force               Overwrite existing files
  --yes                 Skip prompts, use defaults / flag values

Flags (gen):
  --root <dir>          Domain root to scan (e.g. src/domains)
                        — falls back to "root" in .frsrc.json
  --out <file>          Output file relative to --root
                        (default: .frsrc.json "out" or __generated__/routes.ts)
  --routes-file <name>  Filename to look for (default: routes.ts)
  --skip <list>         Comma-separated path segments to drop from URLs
                        (default: useCases,useCase,use-cases,use-case)
  --casing <preserve|kebab>
                        Casing applied to remaining segments (default: preserve)
  --ext <.js|.ts|''>    Import extension in the generated file
                        (default: .js — required for ESM Node.js)
  --exclude <list>      Comma-separated directories to skip
                        (default: node_modules,__generated__,tests,__tests__,dist,build)
  --silent              Do not print the generated route table

Flags (new <name>):
  --root <dir>          Domain root (default: .frsrc.json "root" or src/domains)
  --domain <name>       Domain name (e.g. posts) — prompted if missing
  --method <verb>       HTTP method (default: post) — prompted if missing
  --api <tag>           API tag (default: .frsrc.json first "apis" or v1)
                        — prompted if missing
  --usecase-folder <name>
                        Parent folder under <domain>.
                        Default: .frsrc.json "useCaseFolder" or useCases
  --with-usecase        Also scaffold a sibling <domain>.<name>.useCase.ts file
                        (default: true)
  --with-test           Also scaffold a sibling <domain>.<name>.useCase.test.ts
                        (Vitest, default: true)
  --apis-import <path>  Import path for the registry (default: auto-detect
                        ../../../../apis.js — adjust if your layout differs)
  --force               Overwrite if files already exist
  --yes                 Skip prompts, use defaults / flag values

Flags (add service <name>):
  --services-file <path>
                        Path to the services.ts file (default: src/services.ts)
  --services-dir <dir>  Directory hosting individual service files
                        (default: <dir-of-services-file>/services)
  --force               Overwrite existing files

Flags (add server <admin|crud|sync>):
  --dir <dir>           Directory for the server files (default: .frsrc.json
                        servers dir, or dir of apis.ts, or "src")
  --force               Overwrite existing files
  Scaffolds repos.ts + servers.ts (once) and <type>Server.ts, and records
  their paths in .frsrc.json under "servers".

Flags (sdk:spec):
  --entry <path>        Module exporting a CRUD server (.spec()) or an OpenAPI
                        document. Must be Node-importable (built JS, or run via
                        \`bunx frs sdk:spec ...\` for TS).
  --export <name>       Named export to read (default: auto-detect first spec).
  --out <file>          Output JSON path (default: openapi.json)
  Statically writes the OpenAPI 3.1 spec to a file — no server boot. For Hono:
  \`export const openapi = apis.spec("v1", routes)\` then --export openapi.

Examples:
  frs init
  frs new createPost --domain posts --method post
  frs new listPosts  --domain posts --method get --api v1
  frs add service postRepo
  frs add server admin
  frs add server crud
  frs add server sync
  frs sdk:spec --entry lib/crudServer.js --export api --out openapi.json
`);
}

function asList(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string") return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asString(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  askChoice(
    question: string,
    choices: readonly string[],
    defaultValue?: string,
  ): Promise<string>;
  askBool(question: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

function makePrompter(skip: boolean): Prompter {
  if (skip || !input.isTTY) {
    // Non-interactive: always return the default.
    return {
      ask: async (_q, def) => def ?? "",
      askChoice: async (_q, _c, def) => def ?? "",
      askBool: async (_q, def) => def,
      close: () => undefined,
    };
  }
  const rl = createInterface({ input, output });
  return {
    async ask(question, defaultValue) {
      const hint = defaultValue ? ` (${defaultValue})` : "";
      const answer = (await rl.question(`? ${question}${hint} › `)).trim();
      return answer || defaultValue || "";
    },
    async askChoice(question, choices, defaultValue) {
      const hint = ` [${choices.join("/")}${defaultValue ? `, default: ${defaultValue}` : ""}]`;
      while (true) {
        const answer = (await rl.question(`? ${question}${hint} › `))
          .trim()
          .toLowerCase();
        if (!answer && defaultValue) return defaultValue;
        if (choices.includes(answer)) return answer;
        // eslint-disable-next-line no-console
        console.log(`  invalid choice — pick one of: ${choices.join(", ")}`);
      }
    },
    async askBool(question, defaultValue) {
      const hint = ` (${defaultValue ? "Y/n" : "y/N"})`;
      const answer = (await rl.question(`? ${question}${hint} › `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      return answer === "y" || answer === "yes" || answer === "true";
    },
    close: () => rl.close(),
  };
}

async function runGen(flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = readConfig();
  const root = asString(flags.root) ?? cfg.root;
  if (!root) {
    // eslint-disable-next-line no-console
    console.error(
      "[frs] --root is required (or run `frs init` to write it to .frsrc.json)",
    );
    process.exit(2);
  }
  const rootAbs = resolve(process.cwd(), root);
  if (!existsSync(rootAbs)) {
    // eslint-disable-next-line no-console
    console.error(`[frs] root not found: ${rootAbs}`);
    process.exit(2);
  }

  const out = asString(flags.out) ?? cfg.out ?? "__generated__/routes.ts";

  const skip = asList(flags.skip) ?? DEFAULT_DERIVE.skipSegments;
  const casing =
    asString(flags.casing) === "kebab" ? "kebab" : DEFAULT_DERIVE.casing;
  const derive: PathDeriveOptions = { skipSegments: skip, casing };

  const ext = asString(flags.ext) ?? ".js";
  const exclude = asList(flags.exclude) ?? DEFAULT_SCANNER.excludeSegments;
  const routesFile = asString(flags["routes-file"]) ?? DEFAULT_SCANNER.routesFile;
  const scannerOpts: ScannerOptions = { routesFile, excludeSegments: exclude };

  const scanned = scanRoutes(rootAbs, scannerOpts);
  if (scanned.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[frs] no "${routesFile}" files found under ${rootAbs} — generated an empty manifest.`,
    );
  }

  const result = generateRoutesManifest(scanned, {
    outFile: resolve(rootAbs, out),
    derive,
    importExtension: ext,
  });

  if (!flags.silent) {
    // eslint-disable-next-line no-console
    console.log(
      `[frs] wrote ${result.outFile}  (${result.routeCount} route${
        result.routeCount === 1 ? "" : "s"
      })`,
    );
    for (const { source, url } of result.derivedPaths) {
      // eslint-disable-next-line no-console
      console.log(`  ${url.padEnd(48)}  ←  ${source}`);
    }
  }
}

async function runNew(
  name: string | undefined,
  flags: ParsedArgs["flags"],
): Promise<void> {
  const skipPrompts = flags.yes === true;
  const prompter = makePrompter(skipPrompts);
  const cfg = readConfig();
  try {
    let routeName = name && !name.startsWith("--") ? name : undefined;
    if (!routeName) {
      routeName = (
        await prompter.ask("Route name (e.g. createPost)")
      ).trim();
      if (!routeName) {
        // eslint-disable-next-line no-console
        console.error("[frs] route name is required");
        process.exit(2);
      }
    }

    let domain = asString(flags.domain);
    if (!domain) {
      domain = (await prompter.ask("Domain name (e.g. posts)")).trim();
      if (!domain) {
        // eslint-disable-next-line no-console
        console.error("[frs] --domain is required");
        process.exit(2);
      }
    }

    const root = asString(flags.root) ?? cfg.root ?? "src/domains";
    let method = asString(flags.method)?.toLowerCase();
    if (!method) {
      method = await prompter.askChoice(
        "HTTP method",
        ["get", "post", "put", "patch", "delete"],
        "post",
      );
    }
    if (!["get", "post", "put", "patch", "delete"].includes(method)) {
      // eslint-disable-next-line no-console
      console.error(`[frs] invalid --method: ${method}`);
      process.exit(2);
    }

    let api = asString(flags.api);
    if (!api) {
      const defaultApi = cfg.apis?.[0] ?? "v1";
      api = (await prompter.ask("API tag", defaultApi)).trim() || defaultApi;
    }

    const useCaseFolder =
      asString(flags["usecase-folder"]) ?? cfg.useCaseFolder ?? "useCases";
    const withUseCase =
      flags["with-usecase"] === undefined
        ? skipPrompts
          ? true
          : await prompter.askBool("Scaffold useCase.ts?", true)
        : flags["with-usecase"] !== false;
    const withTest =
      flags["with-test"] === undefined
        ? skipPrompts || !withUseCase
          ? withUseCase
          : await prompter.askBool("Scaffold useCase.test.ts (Vitest)?", true)
        : flags["with-test"] !== false;
    const force = flags.force === true;

    const rootAbs = resolve(process.cwd(), root);
    const dirAbs = resolve(rootAbs, domain, useCaseFolder, routeName);
    const routesFile = resolve(dirAbs, "routes.ts");
    // useCase / test files are prefixed with `<domain>.<routeName>` so they are
    // unique across the project (Ctrl+P friendly), unlike a bare `useCase.ts`.
    const useCaseBase = `${domain}.${routeName}.useCase`;
    const useCaseFile = resolve(dirAbs, `${useCaseBase}.ts`);
    const testFile = resolve(dirAbs, `${useCaseBase}.test.ts`);

    mkdirSync(dirAbs, { recursive: true });

    const capitalize = (s: string) =>
      s.charAt(0).toUpperCase() + s.slice(1);
    const className = `${capitalize(domain)}${capitalize(routeName)}UseCase`;

    const pkgHono = "@lpdjs/firestore-repo-service/servers/hono";
    const servicesImport = inferServicesImportPath(rootAbs, dirAbs);
    const baseUseCaseImport = inferBaseUseCaseImportPath(rootAbs, dirAbs);

    const inputComment =
      method === "get"
        ? "// GET → lu depuis les query params"
        : `// ${method.toUpperCase()} → lu depuis le body JSON`;

    const useCaseSrc = `/**
 * ${className} — pure business logic, no HTTP awareness.
 *
 * Owns its Zod \`input\` / \`output\` schemas (declared as \`static\` members, the
 * single source of truth shared with \`routes.ts\`) and runs the logic in
 * \`execute\`. Extends \`AppUseCase\`, so \`this.services\`, \`this.logger\` and
 * \`this.error\` are all available.
 */

import { z } from "zod";
import { AppUseCase } from "${baseUseCaseImport}";

const input = z.object({
  ${inputComment}
  example: z.string(),
});

const output = z.object({
  id: z.string(),
});

export class ${className} extends AppUseCase<typeof input, typeof output> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
    this.logger.info("${className} called", { example: payload.example });
    // Guard example — mapped to HTTP by the AppErrorHandler:
    // if (!payload.example) throw this.error.badRequest("example is required");

    // TODO: implement using \`this.services\`
    return { id: payload.example };
  }
}
`;

    const sourceMeta =
      method === "get" ? `\n    source: "query",` : "";

    const useCaseImport = withUseCase
      ? `import { ${className} } from "./${useCaseBase}.js";\n`
      : "";

    const apisImport =
      asString(flags["apis-import"]) ??
      inferApisImportPath(rootAbs, dirAbs);

    const routesSrc = withUseCase
      ? `import { defineRoutes } from "${pkgHono}";
import { useCaseRoute } from "${apisImport}";
${useCaseImport}
export default defineRoutes([
  useCaseRoute(${className}, {
    api: "${api}",
    method: "${method}",${sourceMeta}
    summary: "TODO: ${routeName}",
    tags: ["${domain}"],
  }),
]);
`
      : `import { z } from "zod";
import { defineRoutes } from "${pkgHono}";
import { defineRoute } from "${apisImport}";

export default defineRoutes([
  defineRoute({
    api: "${api}",
    method: "${method}",

    input: z.object({
      ${inputComment}
      example: z.string(),
    }),

    output: z.object({
      id: z.string(),
    }),

    summary: "TODO: ${routeName}",
    tags: ["${domain}"],

    handler: async ({ input }) => {
      // TODO: business logic
      return { id: input.example };
    },
  }),
]);
`;

    const written: string[] = [];
    const skipped: string[] = [];

    const writeIfPossible = (file: string, content: string) => {
      if (existsSync(file) && !force) {
        skipped.push(file);
        return;
      }
      writeFileSync(file, content, "utf8");
      written.push(file);
    };

    writeIfPossible(routesFile, routesSrc);
    if (withUseCase) writeIfPossible(useCaseFile, useCaseSrc);
    if (withUseCase && withTest) {
      const testSrc = `import { describe, it, expect } from "vitest";
import type { Services } from "${servicesImport}";
import { ${className} } from "./${useCaseBase}.js";

describe("${className}", () => {
  it("returns a response shaped like the output schema", async () => {
    // TODO: replace with real mocks for the services the useCase consumes.
    const services = {} as unknown as Services;

    const useCase = new ${className}(services);
    const result = await useCase.execute({ example: "hello" });
    expect(result).toMatchObject({ id: expect.any(String) });
  });

  // TODO: add error-path tests, repository mocks, etc.
});
`;
      writeIfPossible(testFile, testSrc);
    }

    // eslint-disable-next-line no-console
    for (const f of written) console.log(`[frs] wrote   ${f}`);
    for (const f of skipped)
      // eslint-disable-next-line no-console
      console.log(`[frs] skipped ${f} (use --force to overwrite)`);
    // eslint-disable-next-line no-console
    console.log(
      `\n[frs] reminder: run "frs gen --root ${root}" to refresh the manifest.`,
    );
  } finally {
    prompter.close();
  }
}

// ---------------------------------------------------------------------------
// `init` — bootstrap a fresh project layout
// ---------------------------------------------------------------------------

async function runInit(flags: ParsedArgs["flags"]): Promise<void> {
  const skipPrompts = flags.yes === true;
  const prompter = makePrompter(skipPrompts);
  try {
    const force = flags.force === true;

    let root = asString(flags.root);
    if (!root) {
      root = (await prompter.ask("Domain root", "src/domains")).trim() || "src/domains";
    }

    let apisFile = asString(flags["apis-file"]);
    if (!apisFile) {
      apisFile = (await prompter.ask("apis.ts location", "src/apis.ts")).trim() || "src/apis.ts";
    }

    let servicesFile = asString(flags["services-file"]);
    if (!servicesFile) {
      const defaultServices = apisFile.replace(/apis\.ts$/, "services.ts") || "src/services.ts";
      servicesFile =
        (await prompter.ask("services.ts location", defaultServices)).trim() ||
        defaultServices;
    }

    let apisRaw = asString(flags.apis);
    if (!apisRaw) {
      apisRaw = (await prompter.ask("API tags (comma-separated)", "v1")).trim() || "v1";
    }
    const apis = apisRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (apis.length === 0) {
      // eslint-disable-next-line no-console
      console.error("[frs] at least one API tag is required");
      process.exit(2);
    }

    const basePathFlag = asString(flags["base-path"]);

    const rootAbs = resolve(process.cwd(), root);
    const apisAbs = resolve(process.cwd(), apisFile);
    const servicesAbs = resolve(process.cwd(), servicesFile);
    const appErrorAbs = resolve(dirname(apisAbs), "app-error.ts");
    const baseUseCaseAbs = resolve(dirname(apisAbs), "base-usecase.ts");
    const generatedDir = resolve(rootAbs, "__generated__");
    const generatedFile = resolve(generatedDir, "routes.ts");

    const written: string[] = [];
    const skipped: string[] = [];
    const writeIfPossible = (file: string, content: string) => {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && !force) {
        skipped.push(file);
        return;
      }
      writeFileSync(file, content, "utf8");
      written.push(file);
    };

    // 1) apis.ts ----------------------------------------------------------
    const apisBody = apis
      .map((tag) => {
        const basePath = basePathFlag ?? `/${tag}`;
        return `    ${tag}: {
      basePath: "${basePath}",
      openapi: {
        info: { title: "${tag.toUpperCase()} API", version: "1.0.0", description: "" },
      },
      // Maps your AppError → HTTP (extend it in app-error.ts). \`gcpLogs\` adds a
      // dev-only deep link to the matching GCP log in the error response.
      errorHandler: new AppErrorHandler({
        gcpLogs: { enabled: process.env["NODE_ENV"] !== "production" },
      }),
      // Shared structured logger (same instance exposed as \`this.logger\`).
      logger: appLogger,
      verbose: process.env["NODE_ENV"] !== "production",
    },`;
      })
      .join("\n");

    const apisSrc = `import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { AppErrorHandler, appLogger } from "${relativeImport(dirname(apisAbs), appErrorAbs)}";
import { services } from "${relativeImport(dirname(apisAbs), servicesAbs)}";

/**
 * Single source of truth for every API exposed by this project.
 * Add per-API middlewares, interceptors, OpenAPI metadata here.
 *
 * Per-API resources injected into every handler / interceptor / error-handler
 * context (override them per API above):
 *   - \`services\`     — shared DI container (\`services.ctx.c\` = current request);
 *   - \`errorHandler\` — maps thrown \`AppError\`s → HTTP (see app-error.ts);
 *   - \`logger\`       — structured logging (also \`this.logger\` in useCases).
 */
export const apis = createApiRegistry(
  {
${apisBody}
  },
  { services },
);

/** Typed helpers used inside every route file. */
export const defineRoute = apis.defineRoute;
export const useCaseRoute = apis.useCaseRoute;
`;

    writeIfPossible(apisAbs, apisSrc);

    // 1.b services.ts ----------------------------------------------------
    const servicesSrc = `import { createServices } from "@lpdjs/firestore-repo-service/servers/hono";

/**
 * Global DI container — declare every singleton (repositories, SDK
 * clients, loggers, useCases) here. Each factory is invoked once on first
 * access and the instance is cached for the process lifetime.
 *
 * Factories receive a typed proxy of every other service plus the
 * built-in \`ctx\` (current request \`Context\` via AsyncLocalStorage).
 * Destructure what you need — TypeScript will infer everything.
 *
 * NOTE: prefer **factory form with destructured deps** for anything that
 * needs to reference its dependencies inside its own class — typing a
 * field as the full \`Services\` would create a circular type alias.
 * Classes can be passed directly only when they don't reference
 * \`Services\` themselves (e.g. plain SDK wrappers).
 *
 * @example
 * \`\`\`ts
 * postRepo: ({ ctx }) => new PostRepo(ctx),
 * createPostUseCase: ({ ctx, postRepo }) =>
 *   new CreatePostUseCase(ctx, postRepo),
 * \`\`\`
 */
export const services = createServices({
  // TODO: declare your services here.
  // Example:
  //   db: () => getFirestore(),
  //   postRepo: ({ ctx, db }) => new PostRepo(ctx, db),
});

/** Convenience type — \`function fn(svc: Services) { ... }\`. */
export type Services = typeof services;
`;

    writeIfPossible(servicesAbs, servicesSrc);

    // 1.c app-error.ts — AppError + AppLogger + AppErrorHandler -----------
    const appErrorSrc = `import {
  BaseErrorHandler,
  BaseLogger,
  type ErrorHandlerContext,
  type LogSeverity,
} from "@lpdjs/firestore-repo-service/servers/hono";

/** Supported locales — the single source of truth (runtime + type). */
export const LOCALES = ["en", "fr"] as const;

/** A supported locale, derived from {@link LOCALES}. */
export type Locale = (typeof LOCALES)[number];

/** Localized message — one string per supported locale. */
export type LocalizedMessage = Record<Locale, string>;

/**
 * Domain error — pure business semantics, zero HTTP awareness. Thrown anywhere
 * in useCases / handlers; the \`AppErrorHandler\` below maps it to an HTTP
 * response. Carries a localized message; add your own factory methods as your
 * domain grows.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly userFacing: boolean;
  readonly errorId: string;
  readonly localizedMessage: LocalizedMessage;

  private constructor(
    localizedMessage: LocalizedMessage,
    statusCode: number,
    userFacing = false,
  ) {
    super(localizedMessage.en);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.userFacing = userFacing;
    this.localizedMessage = localizedMessage;
    this.errorId = Math.random().toString(36).slice(2, 12);
  }

  /** Business message shown directly to the user — HTTP 412. */
  static userMessage(message: LocalizedMessage): AppError {
    return new AppError(message, 412, true);
  }

  /** Resource not found — HTTP 404. */
  static notFound(resource?: string): AppError {
    return new AppError(
      {
        en: \`\${resource ?? "Resource"} not found\`,
        fr: \`\${resource ?? "Ressource"} introuvable\`,
      },
      404,
    );
  }

  /** Malformed request / invalid data — HTTP 400. */
  static badRequest(detail?: string): AppError {
    return new AppError(
      {
        en: \`Bad request: \${detail ?? "invalid parameters"}\`,
        fr: \`Requête invalide : \${detail ?? "paramètres incorrects"}\`,
      },
      400,
    );
  }

  /** Generic fallback message for non-user-facing errors. */
  static default(locale: Locale): string {
    return locale === "fr" ? "Une erreur est survenue" : "An error occurred";
  }
}

/**
 * Pick the response locale from the \`Accept-Language\` header.
 *
 * Parses the comma-separated, q-weighted list (e.g.
 * \`fr-FR,fr;q=0.9,en;q=0.8\`), keeps the supported locales, and returns the one
 * with the highest quality. Falls back to \`"en"\`.
 */
function pickLocale(c: {
  req: { header(name: string): string | undefined };
}): Locale {
  const header = c.req.header("accept-language");
  if (!header) return "en";

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=")[1] ?? "") : 1;
      return {
        lang: tag.trim().toLowerCase().split("-")[0] ?? "",
        quality: Number.isFinite(q) ? q : 1,
      };
    })
    .filter((x): x is { lang: Locale; quality: number } =>
      (LOCALES as readonly string[]).includes(x.lang),
    )
    .sort((a, b) => b.quality - a.quality);

  return ranked[0]?.lang ?? "en";
}

/**
 * Project logger — extends \`BaseLogger\` and overrides the single \`write\` hook.
 * Swap \`console\` for \`firebase-functions/v2\` \`logger\` in real code.
 */
export class AppLogger extends BaseLogger {
  protected override write(
    severity: LogSeverity,
    payload: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ severity, ...payload }));
  }
}

/** Shared logger instance (per-API \`logger\` + \`this.logger\` in useCases). */
export const appLogger = new AppLogger();

/**
 * Project error strategy — extends \`BaseErrorHandler\`: \`mapError\` localizes our
 * \`AppError\` (user-facing aware, with an optional GCP logs deep link),
 * \`logError\` routes through the logger, and unmatched errors fall back to the
 * built-in mapping via \`super\`. Wired per API in apis.ts.
 */
export class AppErrorHandler extends BaseErrorHandler {
  protected override mapError({
    error,
    c,
  }: ErrorHandlerContext): Response | null {
    if (!(error instanceof AppError)) return null; // → built-in mapping

    const locale = pickLocale(c);
    const logsUrl = this.gcpLogsUrl(error.errorId); // undefined when disabled
    return c.json(
      {
        // expose the localized message only when it is meant for the user
        error: error.userFacing
          ? error.localizedMessage[locale]
          : AppError.default(locale),
        errorId: error.errorId,
        ...(logsUrl ? { logsUrl } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error.statusCode as any,
    );
  }

  protected override logError({ error, logger }: ErrorHandlerContext): void {
    const log = logger ?? appLogger;
    if (error instanceof AppError && error.statusCode < 500) {
      log.warn(error.message);
    } else {
      log.error(error);
    }
  }
}
`;
    writeIfPossible(appErrorAbs, appErrorSrc);

    // 1.d base-usecase.ts — AppUseCase (this.services + this.logger + this.error)
    const baseUseCaseSrc = `import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { z } from "zod";
import { AppError, appLogger } from "${relativeImport(dirname(baseUseCaseAbs), appErrorAbs)}";
import type { Services } from "${relativeImport(dirname(baseUseCaseAbs), servicesAbs)}";

/**
 * Project base class for every useCase — extends the package's {@link UseCase}
 * (which injects \`this.services\` via the constructor) and adds two shared
 * ergonomics: \`this.logger\` (structured logger) and \`this.error\` (the
 * {@link AppError} factory, mapped to HTTP by the \`AppErrorHandler\`).
 * Subclasses still declare \`static input\` / \`static output\`.
 */
export abstract class AppUseCase<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> extends UseCase<TInput, TOutput, Services> {
  /** Shared structured logger instance (same one injected per-API). */
  protected readonly logger = appLogger;

  /**
   * Domain error factory — \`throw this.error.notFound(...)\` /
   * \`this.error.badRequest(...)\` / \`this.error.userMessage(...)\`. The thrown
   * {@link AppError} is mapped to an HTTP response by the \`AppErrorHandler\`.
   */
  protected readonly error = AppError;
}
`;
    writeIfPossible(baseUseCaseAbs, baseUseCaseSrc);

    // 2) Empty generated manifest stub -----------------------------------
    const stubSrc = `// AUTO-GENERATED by frs — do not edit.
// Run \`frs gen --root ${root}\` to refresh.

import type { AnyRouteDef } from "@lpdjs/firestore-repo-service/servers/hono";

export const routes: AnyRouteDef[] = [];
`;
    writeIfPossible(generatedFile, stubSrc);

    // 2.b) Persist resolved layout for sibling commands (`frs add` …) -----
    const cfgFile = writeConfig({
      root,
      apisFile,
      servicesFile,
      apis,
    });
    written.push(cfgFile);

    // 3) index.ts snippet hint -------------------------------------------
    const apisImportPath = relativeImport(dirname(apisAbs), apisAbs);
    const routesImportPath = relativeImport(dirname(apisAbs), generatedFile);
    const exportsLine = apis.length === 1
      ? `export const { ${apis[0]} } = apis.toFunctions(routes, onRequest, {`
      : `export const { ${apis.join(", ")} } = apis.toFunctions(routes, onRequest, {`;

    // eslint-disable-next-line no-console
    for (const f of written) console.log(`[frs] wrote   ${f}`);
    for (const f of skipped)
      // eslint-disable-next-line no-console
      console.log(`[frs] skipped ${f} (use --force to overwrite)`);

    // eslint-disable-next-line no-console
    console.log(`
Next steps:

1. Wire the registry in your Functions entrypoint (e.g. src/index.ts):

   import { onRequest } from "firebase-functions/v2/https";
   import { apis } from "${apisImportPath}";
   import { routes } from "${routesImportPath}";

   ${exportsLine}
     defaults: { region: "us-central1", invoker: "public" },
   });

2. Scaffold a first route:

   frs new createPost --domain posts --method post --api ${apis[0]}

3. Refresh the manifest before each build:

   frs gen --root ${root}
`);
  } finally {
    prompter.close();
  }
}

function relativeImport(fromDir: string, toFile: string): string {
  let rel = relative(fromDir, toFile).replace(/\\/g, "/");
  rel = rel.replace(/\.ts$/, ".js");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

// ---------------------------------------------------------------------------
// `add service <name>` — scaffold a new service file and register it
// ---------------------------------------------------------------------------

async function runAdd(
  what: string | undefined,
  name: string | undefined,
  flags: ParsedArgs["flags"],
): Promise<void> {
  if (what === "server") {
    await runAddServer(name, flags);
    return;
  }
  if (what !== "service") {
    // eslint-disable-next-line no-console
    console.error(
      `[frs] unknown "add" target: ${what ?? "(missing)"} — supported: service, server`,
    );
    process.exit(2);
  }
  if (!name) {
    // eslint-disable-next-line no-console
    console.error("[frs] service name is required: frs add service <name>");
    process.exit(2);
  }

  const force = flags.force === true;
  const cfg = readConfig();
  const servicesFileFlag = asString(flags["services-file"]);
  const candidates = [
    servicesFileFlag,
    cfg.servicesFile,
    "src/services.ts",
    "services.ts",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  let servicesAbs: string | undefined;
  for (const c of candidates) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) {
      servicesAbs = abs;
      break;
    }
  }

  if (!servicesAbs) {
    const tried = candidates.map((c) => resolve(process.cwd(), c)).join("\n        ");
    // eslint-disable-next-line no-console
    console.error(
      `[frs] services file not found. Tried:\n        ${tried}\n` +
        `      Run \`frs init\` first or pass --services-file <path>.`,
    );
    process.exit(2);
  }

  const servicesDir =
    asString(flags["services-dir"]) ??
    cfg.servicesDir ??
    resolve(dirname(servicesAbs), "services");
  const dirAbs = resolve(process.cwd(), servicesDir);

  mkdirSync(dirAbs, { recursive: true });

  const className = `${name.charAt(0).toUpperCase()}${name.slice(1)}Service`;
  const fileAbs = resolve(dirAbs, `${name}.ts`);

  const serviceSrc = `import type { RequestContext } from "@lpdjs/firestore-repo-service/servers/hono";

/**
 * ${className} — generated by \`frs add service ${name}\`.
 *
 * Registered with a **factory** in \`services.ts\` so dependencies are
 * destructured at registration time. Add new constructor parameters here
 * and update the factory line (\`({ ctx, otherSvc }) => new ${className}(ctx, otherSvc)\`)
 * — TypeScript will tell you when something is missing.
 *
 * Async resources (DB connections, SDK clients) should stay lazy-loaded
 * inside the class to keep cold-starts fast:
 *
 * @example
 * \`\`\`ts
 * private _client: SomeClient | undefined;
 * get client(): SomeClient {
 *   return (this._client ??= new SomeClient({...}));
 * }
 * \`\`\`
 */
export class ${className} {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(private readonly ctx: RequestContext) {}

  hello(): string {
    return \`hello from ${name} — user=\${this.ctx.maybeC?.get("user")?.id ?? "anonymous"}\`;
  }
}
`;

  if (existsSync(fileAbs) && !force) {
    // eslint-disable-next-line no-console
    console.log(`[frs] skipped ${fileAbs} (use --force to overwrite)`);
  } else {
    writeFileSync(fileAbs, serviceSrc, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[frs] wrote   ${fileAbs}`);
  }

  // Register in services.ts ------------------------------------------------
  const current = readFileSync(servicesAbs, "utf8");
  const importPath = relativeImport(dirname(servicesAbs), fileAbs);
  const importLine = `import { ${className} } from "${importPath}";`;
  const factoryLine = `  ${name}: ({ ctx }) => new ${className}(ctx),`;

  if (current.includes(importLine)) {
    // eslint-disable-next-line no-console
    console.log(`[frs] services.ts already registers "${name}" — skipping.`);
    return;
  }

  // Insert import after the last existing top-level import (or at the top).
  const lines = current.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i]!)) lastImportIdx = i;
  }
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
  } else {
    lines.unshift(importLine);
  }

  // Insert factory line inside `createServices({ ... })`.
  const joined = lines.join("\n");
  const callMatch = joined.match(/createServices\s*\(\s*\{/);
  if (!callMatch) {
    // eslint-disable-next-line no-console
    console.error(
      `[frs] could not find \`createServices({\` in ${servicesAbs} — ` +
        `register "${name}" manually.`,
    );
    return;
  }
  const openBraceIdx = callMatch.index! + callMatch[0].length;
  const updated =
    joined.slice(0, openBraceIdx) +
    "\n" +
    factoryLine +
    joined.slice(openBraceIdx);

  writeFileSync(servicesAbs, updated, "utf8");
  // eslint-disable-next-line no-console
  console.log(`[frs] updated ${servicesAbs}  (+ ${name})`);
}

// ---------------------------------------------------------------------------
// `add server <admin|crud|sync>` — scaffold an ORM server (one file per server)
// ---------------------------------------------------------------------------

const PKG = "@lpdjs/firestore-repo-service";

/** Repository registry (`repos.ts`) — lazy Firestore, one example repo. */
function reposTemplate(): string {
  return `import { type Firestore, getFirestore } from "firebase-admin/firestore";
import {
  createRepositoryConfig,
  createRepositoryMapping,
} from "${PKG}";
import { z } from "zod";

/**
 * Repository registry — the single source of truth shared by every ORM server
 * (admin / crud / sync). The \`getFirestore\` factory is resolved lazily (on
 * first repository use), so this file can be imported before \`initializeApp()\`.
 */

// Example model — replace with your own schema(s).
const exampleSchema = z.object({
  docId: z.string(),
  name: z.string(),
});

export const repos = createRepositoryMapping(() => getFirestore(), {
  example: createRepositoryConfig(exampleSchema)({
    path: "examples",
    isGroup: false,
    foreignKeys: ["docId"] as const,
    queryKeys: [] as const,
    documentKey: "docId",
    refCb: (db: Firestore, docId: string) =>
      db.collection("examples").doc(docId),
  }),
  // TODO: add your repositories here.
});
`;
}

/** Shared `servers.ts` — wires the registry into `createServers`. */
function serversRootTemplate(reposImport: string): string {
  return `import { onRequest } from "firebase-functions/v2/https";
import { createServers } from "${PKG}";
import { repos } from "${reposImport}";

/**
 * Shared server factory, pre-bound to the repository registry. Each server is
 * defined in its own file (e.g. \`adminServer.ts\`) via \`servers.admin(...)\`,
 * \`servers.crud(...)\`, \`servers.sync(...)\` and re-exported from your Functions
 * entrypoint. Passing \`onRequest\` makes the admin/crud builders return a
 * ready-to-export Cloud Function.
 */
export const servers = createServers(repos, { onRequest });
`;
}

/** Per-server templates, keyed by server type. */
function serverTemplate(type: "admin" | "crud" | "sync", serversImport: string): string {
  if (type === "admin") {
    return `import { servers } from "${serversImport}";

/**
 * Admin UI server. Each key maps a repository (from the registry) to its admin
 * display/permissions config. Export this from your Functions entrypoint.
 */
export const admin = servers.admin({
  basePath: "/admin",
  repos: {
    example: { path: "examples", allowDelete: true },
    // TODO: add the repositories you want to expose in the admin UI.
  },
});
`;
  }
  if (type === "crud") {
    return `import { servers } from "${serversImport}";

/**
 * CRUD REST API server. Each key maps a repository to its CRUD config (rules,
 * field roles, …). Export this from your Functions entrypoint.
 */
export const api = servers.crud({
  basePath: "/api",
  repos: {
    example: { path: "examples", allowDelete: true },
    // TODO: add the repositories you want to expose over REST.
  },
});
`;
  }
  // sync
  return `import * as firestoreTriggers from "firebase-functions/v2/firestore";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { onRequest } from "firebase-functions/v2/https";
// TODO: \`npm i @google-cloud/pubsub\` and provide a SQL adapter (e.g. BigQuery).
import { PubSub } from "@google-cloud/pubsub";
import { servers } from "${serversImport}";

/**
 * Firestore → SQL sync pipeline (triggers + worker + optional admin). Spread
 * the returned \`functions\` from your Functions entrypoint:
 *   export const { functions: syncFunctions } = sync;
 */
export const sync = servers.sync({
  deps: {
    firestoreTriggers,
    pubsubHandler: onMessagePublished,
    pubsub: new PubSub(),
  },
  // TODO: provide your SQL adapter (e.g. a BigQuery adapter instance).
  adapter: undefined as any,
  repos: {
    // example: { tableName: "examples" },
    // TODO: map repositories to their SQL tables.
  },
  // Optional bundled admin endpoint:
  // admin: { onRequest, basePath: "/__sync" },
});
`;
}

async function runAddServer(
  type: string | undefined,
  flags: ParsedArgs["flags"],
): Promise<void> {
  const valid = ["admin", "crud", "sync"] as const;
  if (!type || !(valid as readonly string[]).includes(type)) {
    // eslint-disable-next-line no-console
    console.error(
      `[frs] server type is required: frs add server <${valid.join("|")}>`,
    );
    process.exit(2);
  }
  const serverType = type as (typeof valid)[number];
  const force = flags.force === true;
  const cfg = readConfig();

  // Base directory: reuse the directory of an existing servers root / repos /
  // apis file, else `--dir`, else `src`.
  const dirFlag = asString(flags.dir);
  const baseDir =
    dirFlag ??
    (cfg.servers?.rootPath && dirname(cfg.servers.rootPath)) ??
    (cfg.apisFile && dirname(cfg.apisFile)) ??
    "src";

  const reposPath = cfg.servers?.reposPath ?? `${baseDir}/repos.ts`;
  const rootPath = cfg.servers?.rootPath ?? `${baseDir}/servers.ts`;
  const serverFileName =
    serverType === "crud" ? "crudServer.ts" : `${serverType}Server.ts`;
  const serverPath = cfg.servers?.[serverType] ?? `${baseDir}/${serverFileName}`;

  const reposAbs = resolve(process.cwd(), reposPath);
  const rootAbs = resolve(process.cwd(), rootPath);
  const serverAbs = resolve(process.cwd(), serverPath);

  const written: string[] = [];
  const skipped: string[] = [];
  const writeIfPossible = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && !force) {
      skipped.push(file);
      return;
    }
    writeFileSync(file, content, "utf8");
    written.push(file);
  };

  // 1) repos.ts (registry) — scaffolded once.
  writeIfPossible(reposAbs, reposTemplate());

  // 2) servers.ts (shared factory) — scaffolded once, imports the registry.
  writeIfPossible(
    rootAbs,
    serversRootTemplate(relativeImport(dirname(rootAbs), reposAbs)),
  );

  // 3) <type>Server.ts — the requested server.
  writeIfPossible(
    serverAbs,
    serverTemplate(serverType, relativeImport(dirname(serverAbs), rootAbs)),
  );

  // 4) Persist resolved paths under `servers` in .frsrc.json.
  const cfgFile = writeConfig({
    servers: {
      ...cfg.servers,
      rootPath,
      reposPath,
      [serverType]: serverPath,
    },
  });
  written.push(cfgFile);

  // eslint-disable-next-line no-console
  for (const f of written) console.log(`[frs] wrote   ${f}`);
  for (const f of skipped)
    // eslint-disable-next-line no-console
    console.log(`[frs] skipped ${f} (use --force to overwrite)`);
  // eslint-disable-next-line no-console
  console.log(
    `\n[frs] reminder: export the \`${serverType === "crud" ? "api" : serverType}\` from your Functions entrypoint (e.g. src/index.ts).`,
  );
}

// ---------------------------------------------------------------------------
// `sdk:spec` — statically export an OpenAPI 3.1 document to a JSON file
// ---------------------------------------------------------------------------

/** Resolve the OpenAPI document from a module export (CRUD handler or Hono doc). */
function resolveSpecFromExport(value: unknown): Record<string, unknown> | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  // CRUD server handler / wrapped Cloud Function → `.spec()`.
  const spec = (value as { spec?: unknown }).spec;
  if (typeof spec === "function") {
    const doc = (spec as () => unknown).call(value);
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  }
  // Plain OpenAPI document (e.g. `apis.spec("v1", routes)` result).
  if (typeof (value as { openapi?: unknown }).openapi === "string") {
    return value as Record<string, unknown>;
  }
  return null;
}

async function runSdkSpec(flags: ParsedArgs["flags"]): Promise<void> {
  const entry = asString(flags.entry);
  if (!entry) {
    // eslint-disable-next-line no-console
    console.error(
      "[frs] --entry <module> is required: frs sdk:spec --entry <path> [--export <name>] [--out openapi.json]\n" +
        "      The module must be importable by Node (point at built JS, or run via a TS runtime such as `bun frs ...`).",
    );
    process.exit(2);
  }
  const entryAbs = resolve(process.cwd(), entry);
  if (!existsSync(entryAbs)) {
    // eslint-disable-next-line no-console
    console.error(`[frs] entry not found: ${entryAbs}`);
    process.exit(2);
  }
  // Node can't import a TypeScript entry. When we're not already on a TS-capable
  // runtime, transparently re-run this exact command under `bun` (which imports
  // TS natively) so the whole resolution logic is reused as-is.
  if (/\.tsx?$/.test(entryAbs) && !process.versions.bun) {
    const argv = process.argv.slice(1); // [thisCliPath, ...originalArgs]
    const res = spawnSync("bun", argv, { stdio: "inherit" });
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
      // eslint-disable-next-line no-console
      console.error(
        `[frs] a TypeScript entry needs a TS runtime, and \`bun\` was not found on PATH: ${entry}\n` +
          "      Either: (a) build it to JS first (e.g. tsc → lib/…) and point --entry there, or " +
          "(b) install bun and re-run, or run with `bun frs sdk:spec ...`.",
      );
      process.exit(2);
    }
    process.exit(res.status ?? 0);
  }

  const outFile = asString(flags.out) ?? "openapi.json";
  const exportName = asString(flags.export);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: Record<string, any>;
  try {
    mod = (await import(pathToFileURL(entryAbs).href)) as Record<string, unknown>;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[frs] failed to import ${entry}:\n`, err);
    process.exit(1);
  }

  let doc: Record<string, unknown> | null = null;
  let resolvedFrom = exportName ?? "";
  if (exportName) {
    doc = resolveSpecFromExport(mod[exportName]);
    if (!doc) {
      // eslint-disable-next-line no-console
      console.error(
        `[frs] export "${exportName}" is not a spec source. Expected a CRUD server (with .spec()) or an OpenAPI document.`,
      );
      process.exit(2);
    }
  } else {
    // Auto-detect: first export that yields a spec.
    for (const [name, value] of Object.entries(mod)) {
      const candidate = resolveSpecFromExport(value);
      if (candidate) {
        doc = candidate;
        resolvedFrom = name;
        break;
      }
    }
    if (!doc) {
      // eslint-disable-next-line no-console
      console.error(
        `[frs] no OpenAPI spec found in ${entry}. Export a CRUD server (\`.spec()\`) ` +
          "or an OpenAPI document (e.g. `export const openapi = apis.spec(\"v1\", routes)`), " +
          "or pass --export <name>.",
      );
      process.exit(2);
    }
  }

  const outAbs = resolve(process.cwd(), outFile);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[frs] wrote ${outAbs}  (OpenAPI ${String(doc.openapi ?? "?")} from export "${resolvedFrom}")`,
  );
}

/**
 * Try to find the user's `apis.ts` (or similar) file and return a relative
 * import path from the new route file. Falls back to a sensible placeholder.
 */
function inferApisImportPath(rootAbs: string, routeDirAbs: string): string {
  const candidates = ["apis.ts", "apis.js", "api.ts", "api.js"];
  // Search upwards from rootAbs's parent (typical layout: src/apis.ts + src/domains/…)
  const searchRoots = [
    rootAbs,
    dirname(rootAbs),
    dirname(dirname(rootAbs)),
  ];
  for (const dir of searchRoots) {
    for (const c of candidates) {
      const full = resolve(dir, c);
      if (existsSync(full)) {
        let rel = relative(routeDirAbs, full).replace(/\\/g, "/");
        rel = rel.replace(/\.ts$/, ".js").replace(/\.js$/, ".js");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel;
      }
    }
  }
  return "../../../../apis.js";
}

function inferServicesImportPath(rootAbs: string, routeDirAbs: string): string {
  const candidates = ["services.ts", "services.js"];
  // services.ts is scaffolded as a sibling of apis.ts (see `frs init`).
  const searchRoots = [
    rootAbs,
    dirname(rootAbs),
    dirname(dirname(rootAbs)),
  ];
  for (const dir of searchRoots) {
    for (const c of candidates) {
      const full = resolve(dir, c);
      if (existsSync(full)) {
        let rel = relative(routeDirAbs, full).replace(/\\/g, "/");
        rel = rel.replace(/\.ts$/, ".js");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel;
      }
    }
  }
  return "../../../../services.js";
}

function inferBaseUseCaseImportPath(
  rootAbs: string,
  routeDirAbs: string,
): string {
  const candidates = ["base-usecase.ts", "base-usecase.js"];
  // base-usecase.ts is scaffolded as a sibling of apis.ts (see `frs init`).
  const searchRoots = [rootAbs, dirname(rootAbs), dirname(dirname(rootAbs))];
  for (const dir of searchRoots) {
    for (const c of candidates) {
      const full = resolve(dir, c);
      if (existsSync(full)) {
        let rel = relative(routeDirAbs, full).replace(/\\/g, "/");
        rel = rel.replace(/\.ts$/, ".js");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel;
      }
    }
  }
  return "../../../../base-usecase.js";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "init":
      await runInit(flags);
      return;
    case "gen":
      await runGen(flags);
      return;
    case "new":
      // First positional after `new` is the route name.
      await runNew(argv[1], flags);
      return;
    case "add":
      // `frs add service <name>` — argv[1] = target, argv[2] = name.
      await runAdd(argv[1], argv[2], flags);
      return;
    case "sdk:spec":
      await runSdkSpec(flags);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      // eslint-disable-next-line no-console
      console.error(`[frs] unknown command: ${command}\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
