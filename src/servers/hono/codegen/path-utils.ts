/**
 * URL path inference from filesystem layout.
 *
 * Convention: every `routes.ts` file under the configured root contributes
 * one route. The URL path is derived from its directory chain, optionally
 * skipping segments such as `useCases` so that
 *
 *   domains/activities/useCases/createOrUpdateCustom/routes.ts
 *
 * becomes
 *
 *   /activities/createOrUpdateCustom
 */

export interface PathDeriveOptions {
  /** Segments to drop from the derived path (case-insensitive). */
  skipSegments: string[];
  /**
   * Casing convention applied to each remaining segment.
   * - `"preserve"` — keep the directory name as-is (default),
   * - `"kebab"`    — convert camelCase / PascalCase to kebab-case.
   */
  casing: "preserve" | "kebab";
}

export const DEFAULT_DERIVE: PathDeriveOptions = {
  skipSegments: ["useCases", "useCase", "use-cases", "use-case"],
  casing: "preserve",
};

/**
 * @param relativeDir POSIX-style directory path of the routes file relative
 *                    to the codegen root (no leading slash, no `routes.ts`).
 */
export function derivePath(
  relativeDir: string,
  options: PathDeriveOptions = DEFAULT_DERIVE,
): string {
  const skip = new Set(options.skipSegments.map((s) => s.toLowerCase()));
  const parts = relativeDir
    .split("/")
    .filter(Boolean)
    .filter((p) => !skip.has(p.toLowerCase()))
    .map((p) => (options.casing === "kebab" ? kebab(p) : p));
  return "/" + parts.join("/");
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Convert an absolute filesystem path to a POSIX-style import specifier
 * relative to a directory (the generated file's directory). Always uses
 * forward slashes and prefixes with `./` or `../` as needed.
 */
export function toImportSpecifier(
  fromDir: string,
  toFile: string,
  ext: string,
): string {
  // Both paths are absolute POSIX (the CLI normalises them).
  const fromParts = splitAbs(fromDir);
  const toParts = splitAbs(toFile);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up = fromParts.length - common;
  const down = toParts.slice(common);
  const last = down[down.length - 1] ?? "";
  const stripped = last.replace(/\.[mc]?[tj]sx?$/i, "");
  const finalLast = ext === "" ? stripped : `${stripped}${ext}`;
  down[down.length - 1] = finalLast;
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return prefix + down.join("/");
}

function splitAbs(p: string): string[] {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.split("/").filter((part, i) => !(i === 0 && part === ""));
}
