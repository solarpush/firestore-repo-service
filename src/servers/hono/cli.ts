#!/usr/bin/env node
/**
 * `frs-hono` CLI — codegen + scaffolder for the file-based Hono server.
 *
 * Usage:
 *   frs-hono init                        # interactive project bootstrap
 *   frs-hono gen  --root src/domains
 *   frs-hono new  createPost --domain posts --method post
 *
 * Designed to be a **prebuild step** (e.g. wired into `npm run build`).
 * Outputs a manifest with static imports — no runtime filesystem scanning.
 */

import { resolve, relative, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { DEFAULT_DERIVE, type PathDeriveOptions } from "./codegen/path-utils";
import {
  DEFAULT_SCANNER,
  scanRoutes,
  type ScannerOptions,
} from "./codegen/scanner";
import { generateRoutesManifest } from "./codegen/generator";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
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
  console.log(`frs-hono — Hono file-based codegen

Usage:
  frs-hono init [flags]
  frs-hono gen  [flags]
  frs-hono new  <name> [flags]
  frs-hono help

Flags (init):
  --root <dir>          Domain root to create (default: src/domains)
  --apis-file <path>    Path to the apis.ts file to create (default: src/apis.ts)
  --apis <list>         Comma-separated API tags to register (default: v1)
  --base-path <prefix>  basePath shared by all APIs (default: derived from tag)
  --force               Overwrite existing files
  --yes                 Skip prompts, use defaults / flag values

Flags (gen):
  --root <dir>          Domain root to scan (required, e.g. src/domains)
  --out <file>          Output file relative to --root
                        (default: __generated__/routes.ts)
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
  --root <dir>          Domain root (default: src/domains)
  --domain <name>       Domain name (e.g. posts) — prompted if missing
  --method <verb>       HTTP method (default: post) — prompted if missing
  --api <tag>           API tag (default: v1) — prompted if missing
  --usecase-folder <name>
                        Parent folder under <domain>. Default: useCases
  --with-usecase        Also scaffold a sibling useCase.ts file (default: true)
  --with-test           Also scaffold a sibling useCase.test.ts (Vitest, default: true)
  --apis-import <path>  Import path for the registry (default: auto-detect
                        ../../../../apis.js — adjust if your layout differs)
  --force               Overwrite if files already exist
  --yes                 Skip prompts, use defaults / flag values

Examples:
  frs-hono init
  frs-hono new createPost --domain posts --method post
  frs-hono new listPosts  --domain posts --method get --api v1
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
  const root = asString(flags.root);
  if (!root) {
    // eslint-disable-next-line no-console
    console.error("[frs-hono] --root is required");
    process.exit(2);
  }
  const rootAbs = resolve(process.cwd(), root);
  if (!existsSync(rootAbs)) {
    // eslint-disable-next-line no-console
    console.error(`[frs-hono] root not found: ${rootAbs}`);
    process.exit(2);
  }

  const out = asString(flags.out) ?? "__generated__/routes.ts";

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
      `[frs-hono] no "${routesFile}" files found under ${rootAbs} — generated an empty manifest.`,
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
      `[frs-hono] wrote ${result.outFile}  (${result.routeCount} route${
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
  try {
    let routeName = name && !name.startsWith("--") ? name : undefined;
    if (!routeName) {
      routeName = (
        await prompter.ask("Route name (e.g. createPost)")
      ).trim();
      if (!routeName) {
        // eslint-disable-next-line no-console
        console.error("[frs-hono] route name is required");
        process.exit(2);
      }
    }

    let domain = asString(flags.domain);
    if (!domain) {
      domain = (await prompter.ask("Domain name (e.g. posts)")).trim();
      if (!domain) {
        // eslint-disable-next-line no-console
        console.error("[frs-hono] --domain is required");
        process.exit(2);
      }
    }

    const root = asString(flags.root) ?? "src/domains";
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
      console.error(`[frs-hono] invalid --method: ${method}`);
      process.exit(2);
    }

    let api = asString(flags.api);
    if (!api) {
      api = (await prompter.ask("API tag", "v1")).trim() || "v1";
    }

    const useCaseFolder = asString(flags["usecase-folder"]) ?? "useCases";
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
    const useCaseFile = resolve(dirAbs, "useCase.ts");
    const testFile = resolve(dirAbs, "useCase.test.ts");

    mkdirSync(dirAbs, { recursive: true });

    const className = `${routeName.charAt(0).toUpperCase()}${routeName.slice(1)}UseCase`;

    const useCaseSrc = `/**
 * ${className} — pure business logic, no HTTP awareness.
 * Reusable across multiple routes / cron jobs / triggers.
 */

export interface ${className}Input {
  // TODO: define the input shape
  example: string;
}

export interface ${className}Output {
  // TODO: define the output shape
  id: string;
}

export class ${className} {
  // TODO: inject repositories / services via the constructor.
  // constructor(private readonly repo: SomeRepository) {}

  async execute(input: ${className}Input): Promise<${className}Output> {
    // TODO: implement
    return { id: input.example };
  }
}
`;

    const inputZodSnippet =
      method === "get"
        ? `z.object({\n    // GET → lu depuis les query params\n    example: z.string(),\n  })`
        : `z.object({\n    // ${method.toUpperCase()} → lu depuis le body JSON\n    example: z.string(),\n  })`;

    const handlerBody = withUseCase
      ? `    const useCase = new ${className}();\n    const data = await useCase.execute(input);\n    return data;`
      : `    // TODO: business logic\n    return { id: input.example };`;

    const useCaseImport = withUseCase
      ? `import { ${className} } from "./useCase.js";\n`
      : "";

    const apisImport =
      asString(flags["apis-import"]) ??
      inferApisImportPath(rootAbs, dirAbs);

    const routesSrc = `import { z } from "zod";
import { defineRoute } from "${apisImport}";
${useCaseImport}
export default defineRoute({
  api: "${api}",
  method: "${method}",

  input: ${inputZodSnippet},

  output: z.object({
    id: z.string(),
  }),

  summary: "TODO: ${routeName}",
  tags: ["${domain}"],

  handler: async ({ input }) => {
${handlerBody}
  },
});
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
import { ${className} } from "./useCase.js";

describe("${className}", () => {
  it("returns a response shaped like the output schema", async () => {
    const useCase = new ${className}();
    const result = await useCase.execute({ example: "hello" });
    expect(result).toMatchObject({ id: expect.any(String) });
  });

  // TODO: add error-path tests, repository mocks, etc.
});
`;
      writeIfPossible(testFile, testSrc);
    }

    // eslint-disable-next-line no-console
    for (const f of written) console.log(`[frs-hono] wrote   ${f}`);
    for (const f of skipped)
      // eslint-disable-next-line no-console
      console.log(`[frs-hono] skipped ${f} (use --force to overwrite)`);
    // eslint-disable-next-line no-console
    console.log(
      `\n[frs-hono] reminder: run "frs-hono gen --root ${root}" to refresh the manifest.`,
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
      console.error("[frs-hono] at least one API tag is required");
      process.exit(2);
    }

    const basePathFlag = asString(flags["base-path"]);

    const rootAbs = resolve(process.cwd(), root);
    const apisAbs = resolve(process.cwd(), apisFile);
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
        return `  ${tag}: {
    basePath: "${basePath}",
    openapi: {
      info: { title: "${tag.toUpperCase()} API", version: "1.0.0", description: "" },
    },
    verbose: process.env["NODE_ENV"] !== "production",
  },`;
      })
      .join("\n");

    const apisSrc = `import { createApiRegistry } from "@lpdjs/firestore-repo-service/servers/hono";

/**
 * Single source of truth for every API exposed by this project.
 * Add per-API middlewares, interceptors, OpenAPI metadata here.
 */
export const apis = createApiRegistry({
${apisBody}
});

/** Typed helper used inside every route file. */
export const defineRoute = apis.defineRoute;
`;

    writeIfPossible(apisAbs, apisSrc);

    // 2) Empty generated manifest stub -----------------------------------
    const stubSrc = `// AUTO-GENERATED by frs-hono — do not edit.
// Run \`frs-hono gen --root ${root}\` to refresh.

import type { AnyRouteDef } from "@lpdjs/firestore-repo-service/servers/hono";

export const routes: AnyRouteDef[] = [];
`;
    writeIfPossible(generatedFile, stubSrc);

    // 3) index.ts snippet hint -------------------------------------------
    const apisImportPath = relativeImport(dirname(apisAbs), apisAbs);
    const routesImportPath = relativeImport(dirname(apisAbs), generatedFile);
    const exportsLine = apis.length === 1
      ? `export const { ${apis[0]} } = apis.toFunctions(routes, onRequest, {`
      : `export const { ${apis.join(", ")} } = apis.toFunctions(routes, onRequest, {`;

    // eslint-disable-next-line no-console
    for (const f of written) console.log(`[frs-hono] wrote   ${f}`);
    for (const f of skipped)
      // eslint-disable-next-line no-console
      console.log(`[frs-hono] skipped ${f} (use --force to overwrite)`);

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

   frs-hono new createPost --domain posts --method post --api ${apis[0]}

3. Refresh the manifest before each build:

   frs-hono gen --root ${root}
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
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      // eslint-disable-next-line no-console
      console.error(`[frs-hono] unknown command: ${command}\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
