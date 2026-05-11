/**
 * Migration manager — generates DDL and optionally auto-migrates SQL tables
 * to match the Zod schemas defined in a repository mapping.
 *
 * Migrations are **additive only**: new columns are added, existing columns
 * are never dropped or modified.
 */

import { z } from "zod";
import { zodSchemaToColumns } from "./schema-mapper";
import type {
  GenerateDDLConfig,
  RepoSyncConfig,
  SqlAdapter,
  SqlColumn,
  SqlTableDef,
} from "./types";

export interface MigrateResult {
  /** Tables that were created from scratch */
  created: string[];
  /** Tables that had columns added */
  altered: string[];
  /** Tables that were already up-to-date */
  upToDate: string[];
  /** Tables skipped (no schema available) */
  skipped: string[];
}

/**
 * Auto-migrate all repos: create missing tables, add missing columns.
 *
 * @returns Summary of what was done per table.
 */
export async function autoMigrate<M extends Record<string, any>>(
  repoMapping: M,
  adapter: SqlAdapter,
  config?: GenerateDDLConfig<NoInfer<M>>,
): Promise<MigrateResult> {
  const result: MigrateResult = {
    created: [],
    altered: [],
    upToDate: [],
    skipped: [],
  };

  for (const [repoName, repo] of Object.entries(repoMapping) as [
    string,
    any,
  ][]) {
    const schema: z.ZodObject<any> | undefined =
      (repo as any).schema ?? undefined;
    if (!schema) {
      result.skipped.push(repoName);
      continue;
    }

    const repoCfg = (
      config?.repos as Record<string, RepoSyncConfig<string>> | undefined
    )?.[repoName];
    const tableName = repoCfg?.tableName ?? repoName;
    const documentKey: string =
      (repo as any)._systemKeys?.[0] ?? (repo as any).documentKey ?? "docId";

    const columns = zodSchemaToColumns(schema, adapter.dialect, {
      primaryKey: documentKey,
      exclude: repoCfg?.exclude,
      columnMap: repoCfg?.columnMap as Record<string, string> | undefined,
    });

    const tableDef: SqlTableDef = { tableName, columns };
    const exists = await adapter.tableExists(tableName);

    if (!exists) {
      await adapter.createTable(tableDef);
      result.created.push(tableName);
    } else {
      const existingCols = new Set(await adapter.getTableColumns(tableName));
      const newCols: SqlColumn[] = columns.filter(
        (c) => !existingCols.has(c.name),
      );

      if (newCols.length > 0) {
        await adapter.addColumns(tableName, newCols);
        result.altered.push(tableName);
      } else {
        result.upToDate.push(tableName);
      }
    }
  }

  return result;
}
