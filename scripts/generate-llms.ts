/**
 * Generate `llms.txt` (a concise, link-based index) and `llms-full.txt` (the
 * full concatenated guide content) from the VitePress documentation, so AI
 * agents working in a downstream project get an accurate, version-pinned map of
 * the package's capabilities and configuration.
 *
 * Single source of truth: the EN guides under `docs/static/guide/*.md` and the
 * sidebar order declared in `docs/static/.vitepress/config.mts`. Updating the
 * docs updates the generated files — nothing is hand-maintained here.
 *
 * Output: `dist/llms.txt` + `dist/llms-full.txt` (shipped via the package's
 * `files: ["dist"]`), and a copy under `docs/static/public/` so the docs site
 * serves them at `/llms.txt` and `/llms-full.txt`.
 *
 * Run: `bun scripts/generate-llms.ts` (chained after `tsup` in `npm run build`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE_DIR = resolve(ROOT, "docs/static/guide");
const CONFIG_MTS = resolve(ROOT, "docs/static/.vitepress/config.mts");

interface GuidePage {
  title: string;
  slug: string;
  summary: string;
  body: string;
}

function readPkg(): {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  exports?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
}

/**
 * Extract the ordered `{ title, slug }` list from the EN sidebar in the
 * VitePress config, so new/removed/reordered guides flow through automatically.
 */
function readSidebarOrder(): { title: string; slug: string }[] {
  const src = readFileSync(CONFIG_MTS, "utf8");
  // Only the EN sidebar references `/guide/<slug>` (the FR one uses
  // `/fr/guide/<slug>`), so a single pass over `/guide/` links is unambiguous.
  const out: { title: string; slug: string }[] = [];
  const seen = new Set<string>();
  const re = /\{\s*text:\s*"([^"]+)"\s*,\s*link:\s*"\/guide\/([^"]+)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const slug = m[2]!;
    // The same `/guide/<slug>` link also appears in the top `nav` — keep the
    // first (sidebar) occurrence and drop later duplicates.
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ title: m[1]!, slug });
  }
  return out;
}

/** Strip the leading YAML frontmatter block (`--- … ---`) if present. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  const after = md.indexOf("\n", end + 1);
  return after === -1 ? "" : md.slice(after + 1);
}

/**
 * Normalise VitePress-specific markdown for plain LLM ingestion:
 * turn `::: tip Title` containers into a bold note and drop the closing `:::`.
 */
function cleanVitepress(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const open = line.match(/^:::\s*\w+\s*(.*)$/);
      if (open) return open[1]?.trim() ? `**${open[1].trim()}**` : "";
      if (/^:::\s*$/.test(line)) return "";
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * First "paragraph-like" line of prose after the H1 — used as the one-line
 * summary in the index. Skips headings, code fences, container markers, lists
 * and tables. Returns an empty string when no prose is found.
 */
function extractSummary(body: string): string {
  const lines = body.split("\n");
  let inFence = false;
  let seenH1 = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (/^#\s/.test(line)) {
      seenH1 = true;
      continue;
    }
    if (!seenH1) continue;
    if (
      /^#{2,}\s/.test(line) || // sub-heading
      /^[:>|*\-+]/.test(line) || // container / quote / table / list
      /^\d+\.\s/.test(line) // ordered list
    ) {
      continue;
    }
    // Plain prose line → tidy inline markdown to a single sentence-ish summary.
    return line
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
  }
  return "";
}

function loadGuides(): GuidePage[] {
  const order = readSidebarOrder();
  const guides: GuidePage[] = [];
  for (const { title, slug } of order) {
    const file = resolve(GUIDE_DIR, `${slug}.md`);
    if (!existsSync(file)) {
      console.warn(`[llms] guide not found, skipping: ${slug}.md`);
      continue;
    }
    const body = cleanVitepress(stripFrontmatter(readFileSync(file, "utf8")));
    guides.push({ title, slug, summary: extractSummary(body), body });
  }
  return guides;
}

/** Best-effort `frs help` capture from the freshly built CLI. */
function captureCliHelp(): string | null {
  const cli = resolve(ROOT, "dist/servers/hono/cli.js");
  if (!existsSync(cli)) return null;
  try {
    return execFileSync("node", [cli, "help"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Short, stable descriptions for the published subpath entry points. */
const ENTRY_POINT_DESCRIPTIONS: Record<string, string> = {
  ".": "Core ORM: createRepositoryConfig, createRepositoryMapping (lazy Firestore), typed get/query/aggregate/crud/batch/bulk/transaction.",
  "./servers":
    "createServers(repos) → admin / crud / sync builders (lazy, definable in separate files).",
  "./servers/admin": "Auto-generated admin UI (Zod forms, filtering, relations).",
  "./servers/crud": "CRUD REST API with per-repo rules and OpenAPI spec.",
  "./servers/auth":
    "firebaseAuth: login page + session cookie guard for the admin/crud UIs.",
  "./servers/hono":
    "Hono file-based API server: useCaseRoute, createApiRegistry, BaseErrorHandler, BaseLogger, firebaseDocsAuth, and the `frs` CLI.",
  "./sync": "Firestore → SQL sync pipeline (triggers + worker + admin).",
  "./sync/bigquery": "BigQuery adapter for the sync pipeline.",
  "./history": "Change-history triggers and read API (createHistoryTriggers).",
};

function buildLlmsIndex(
  pkg: ReturnType<typeof readPkg>,
  guides: GuidePage[],
  cliHelp: string | null,
): string {
  const home = pkg.homepage ?? "";
  const exportKeys = Object.keys(pkg.exports ?? { ".": {} });

  const lines: string[] = [];
  lines.push(`# ${pkg.name} (v${pkg.version})`);
  lines.push("");
  lines.push(`> ${pkg.description}`);
  lines.push("");
  lines.push(
    "Type-safe Firestore ORM + servers (admin UI, CRUD REST, Hono file-based API, Firestore→SQL sync, change-history). Firestore is resolved lazily, so registries and servers can be imported before `initializeApp()`. This file is generated from the documentation — see `llms-full.txt` for the full content.",
  );
  lines.push("");

  lines.push("## Guides");
  for (const g of guides) {
    const url = home ? `${home}/guide/${g.slug}` : `/guide/${g.slug}`;
    lines.push(`- [${g.title}](${url})${g.summary ? `: ${g.summary}` : ""}`);
  }
  lines.push("");

  lines.push("## Package entry points");
  for (const key of exportKeys) {
    const spec =
      key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
    const desc = ENTRY_POINT_DESCRIPTIONS[key] ?? "";
    lines.push(`- \`${spec}\`${desc ? ` — ${desc}` : ""}`);
  }
  lines.push("");

  if (cliHelp) {
    lines.push("## CLI (`frs`)");
    lines.push("");
    lines.push("```");
    lines.push(cliHelp);
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function buildLlmsFull(
  pkg: ReturnType<typeof readPkg>,
  guides: GuidePage[],
): string {
  const parts: string[] = [];
  parts.push(`# ${pkg.name} (v${pkg.version}) — full documentation`);
  parts.push("");
  parts.push(`> ${pkg.description}`);
  parts.push("");
  parts.push(
    "Concatenated guide documentation for LLM ingestion. Generated from the VitePress docs.",
  );
  for (const g of guides) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`# ${g.title}`);
    parts.push("");
    // Drop the page's own leading H1 (we prepend the canonical sidebar title).
    parts.push(g.body.replace(/^#\s+.*\n+/, ""));
  }
  return `${parts.join("\n").trim()}\n`;
}

function writeOut(relPath: string, content: string): void {
  const abs = resolve(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  console.log(`[llms] wrote ${relPath} (${content.length} bytes)`);
}

function main(): void {
  const pkg = readPkg();
  const guides = loadGuides();
  if (guides.length === 0) {
    console.warn("[llms] no guides found — skipping generation.");
    return;
  }
  const cliHelp = captureCliHelp();

  const index = buildLlmsIndex(pkg, guides, cliHelp);
  const full = buildLlmsFull(pkg, guides);

  // Shipped with the package (dist is in `files`).
  writeOut("dist/llms.txt", index);
  writeOut("dist/llms-full.txt", full);

  // Served by the docs site at /llms.txt and /llms-full.txt.
  if (existsSync(resolve(ROOT, "docs/static"))) {
    writeOut("docs/static/public/llms.txt", index);
    writeOut("docs/static/public/llms-full.txt", full);
  }
}

main();
