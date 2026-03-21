/**
 * DDL generator — produces CREATE TABLE / ALTER TABLE statements from
 * SqlColumn definitions and a SqlDialect.
 *
 * `generateDDL()` is the public entry point: it walks a repository mapping,
 * converts each repo's Zod schema to columns, and returns the full DDL
 * as a single string.
 */

import { z } from "zod";
import type {
  GenerateDDLConfig,
  RepoSyncConfig,
  SqlColumn,
  SqlDialect,
  SqlTableDef,
} from "./types";
import { zodSchemaToColumns } from "./schema-mapper";

// ---------------------------------------------------------------------------
// Low-level DDL helpers
// ---------------------------------------------------------------------------

/**
 * Generate a CREATE TABLE statement from a table definition.
 * Delegates to the dialect for syntax specifics.
 */
export function createTableDDL(
  dialect: SqlDialect,
  table: SqlTableDef,
): string {
  return dialect.createTableDDL(table);
}

/**
 * Generate ALTER TABLE ADD COLUMN statements for columns missing from an
 * existing table.
 */
export function addColumnsDDL(
  dialect: SqlDialect,
  tableName: string,
  columns: SqlColumn[],
): string {
  return dialect.addColumnsDDL(tableName, columns);
}

// ---------------------------------------------------------------------------
// High-level DDL generation
// ---------------------------------------------------------------------------

/**
 * Walk a full repository mapping and produce DDL for every repo that has a
 * Zod schema attached.
 *
 * @param repoMapping - Object whose values expose `.schema` (ZodObject)
 * @param dialect     - Target SQL dialect
 * @param config      - Optional per-repo overrides (table name, exclusions…)
 * @returns Complete DDL string (one CREATE TABLE per repo, separated by newlines)
 */
export function generateDDL<M extends Record<string, any>>(
  repoMapping: M,
  dialect: SqlDialect,
  config?: GenerateDDLConfig<NoInfer<M>>,
): string {
  const statements: string[] = [];

  for (const [repoName, repo] of Object.entries(repoMapping) as [string, any][]) {
    const schema: z.ZodObject<any> | undefined =
      repo.schema ?? (repo as any)._schema ?? undefined;
    if (!schema) continue;

    const repoCfg = (config?.repos as Record<string, RepoSyncConfig<string>> | undefined)?.[repoName];
    const tableName = repoCfg?.tableName ?? repoName;

    // Detect documentKey from repo metadata
    const documentKey: string =
      (repo as any)._systemKeys?.[0] ??
      (repo as any).documentKey ??
      "docId";

    const columns = zodSchemaToColumns(schema, dialect, {
      primaryKey: documentKey,
      exclude: repoCfg?.exclude,
      columnMap: repoCfg?.columnMap as Record<string, string> | undefined,
    });

    const tableDef: SqlTableDef = { tableName, columns };
    statements.push(createTableDDL(dialect, tableDef));
  }

  return statements.join("\n\n");
}
