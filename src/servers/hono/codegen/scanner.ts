/**
 * Filesystem scanner — walks the configured root and yields every route file.
 * Synchronous and dependency-free (no `fast-glob` etc.) for a tiny CLI footprint.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ScannerOptions {
  /** Filename to look for (default: `routes.ts`). */
  routesFile: string;
  /** Glob-like exclude segments (matched against any path part). */
  excludeSegments: string[];
}

export const DEFAULT_SCANNER: ScannerOptions = {
  routesFile: "routes.ts",
  excludeSegments: [
    "node_modules",
    "__generated__",
    "tests",
    "__tests__",
    ".turbo",
    "dist",
    "build",
    ".next",
  ],
};

export interface ScannedRoute {
  /** Absolute path to the routes file. */
  absPath: string;
  /** Path relative to the scan root (POSIX style). */
  relPath: string;
  /** Directory portion of `relPath` (what {@link derivePath} consumes). */
  relDir: string;
}

export function scanRoutes(
  rootAbs: string,
  options: ScannerOptions = DEFAULT_SCANNER,
): ScannedRoute[] {
  const found: ScannedRoute[] = [];
  walk(rootAbs, rootAbs, options, found);
  // Stable, deterministic order — important for reproducible builds.
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}

function walk(
  root: string,
  dir: string,
  opts: ScannerOptions,
  out: ScannedRoute[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (opts.excludeSegments.includes(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, abs, opts, out);
    } else if (st.isFile() && name === opts.routesFile) {
      const relPath = relative(root, abs).split(sep).join("/");
      const relDir = relPath.replace(/\/?[^/]+$/, "");
      out.push({ absPath: abs, relPath, relDir });
    }
  }
}
