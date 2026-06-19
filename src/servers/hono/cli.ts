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

Examples:
  frs init
  frs new createPost --domain posts --method post
  frs new listPosts  --domain posts --method get --api v1
  frs add service postRepo
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

    const inputComment =
      method === "get"
        ? "// GET → lu depuis les query params"
        : `// ${method.toUpperCase()} → lu depuis le body JSON`;

    const useCaseSrc = `/**
 * ${className} — pure business logic, no HTTP awareness.
 *
 * Owns its Zod \`input\` / \`output\` schemas (declared as \`static\` members, the
 * single source of truth shared with \`routes.ts\`) and runs the logic in
 * \`execute\`. The shared \`services\` container is injected by the \`UseCase\` base
 * class via the constructor.
 */

import { z } from "zod";
import { UseCase } from "${pkgHono}";
import type { Services } from "${servicesImport}";

const input = z.object({
  ${inputComment}
  example: z.string(),
});

const output = z.object({
  id: z.string(),
});

export class ${className} extends UseCase<typeof input, typeof output, Services> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
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
      verbose: process.env["NODE_ENV"] !== "production",
    },`;
      })
      .join("\n");

    const apisSrc = `import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";
import { services } from "${relativeImport(dirname(apisAbs), servicesAbs)}";

/**
 * Single source of truth for every API exposed by this project.
 * Add per-API middlewares, interceptors, OpenAPI metadata here.
 *
 * The shared \`services\` container is injected into every HonoServer the
 * registry builds — handlers / interceptors receive it via \`{ services }\`
 * and the built-in \`services.ctx.c\` resolves to the current request.
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
  if (what !== "service") {
    // eslint-disable-next-line no-console
    console.error(
      `[frs] unknown "add" target: ${what ?? "(missing)"} — supported: service`,
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
