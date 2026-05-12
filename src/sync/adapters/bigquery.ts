import { SYNC_VERSION_COLUMN } from "../constants";
import type {
  LogicalType,
  SqlAdapter,
  SqlColumn,
  SqlDialect,
  SqlTableDef,
} from "../types";
import { normalizeBigQueryType } from "./bigquery-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the BigQuery error is a "concurrent update" serialization
 * conflict (code 400, reason "invalidQuery" containing "serialize access").
 * These are safe to retry after a brief back-off.
 */
function isConcurrentUpdateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["code"] !== 400) return false;
  const errors = Array.isArray(e["errors"]) ? e["errors"] : [];
  return errors.some(
    (x: any) =>
      typeof x?.message === "string" &&
      x.message.toLowerCase().includes("serialize access"),
  );
}

/**
 * Execute `fn`, retrying up to `maxRetries` times when BigQuery returns a
 * concurrent-update error.  Uses full-jitter exponential back-off.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 10,
  baseMs = 500,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isConcurrentUpdateError(err) || attempt > maxRetries) throw err;
      const cap = baseMs * Math.pow(2, attempt);
      const delay = Math.random() * cap; // full jitter
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Dialect (internal — used only by BigQueryAdapter)
// ---------------------------------------------------------------------------

/** BigQuery SQL dialect mapping. */
class BigQueryDialect implements SqlDialect {
  readonly name = "bigquery";

  mapType(logical: LogicalType): string {
    switch (logical) {
      case "string":
        return "STRING";
      case "number":
        return "FLOAT64";
      case "bigint":
        return "INT64";
      case "boolean":
        return "BOOL";
      case "timestamp":
        return "TIMESTAMP";
      case "json":
        return "JSON";
      case "text":
        return "STRING";
    }
  }

  quoteIdentifier(id: string): string {
    return `\`${id}\``;
  }
}

/** Shared BigQuery dialect singleton. */
export const bigqueryDialect: SqlDialect = new BigQueryDialect();

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * BigQuery implementation of {@link SqlAdapter}.
 *
 * Accepts an already-configured BigQuery client so the library does not pull
 * in `@google-cloud/bigquery` as a hard dependency.
 *
 * @example
 * ```ts
 * import { BigQuery } from "@google-cloud/bigquery";
 * import { BigQueryAdapter } from "./adapters/bigquery";
 *
 * const adapter = new BigQueryAdapter({
 *   bigquery: new BigQuery({ projectId: "my-project" }),
 *   datasetId: "my_dataset",
 * });
 * ```
 */
export class BigQueryAdapter implements SqlAdapter {
  private readonly bigquery: any;
  private readonly datasetId: string;

  constructor(options: { bigquery: any; datasetId: string }) {
    this.bigquery = options.bigquery;
    this.datasetId = options.datasetId;
  }

  /** The BigQuery SQL dialect. */
  get dialect(): SqlDialect {
    return bigqueryDialect;
  }

  /** Check whether a table exists in the dataset. */
  async tableExists(tableName: string): Promise<boolean> {
    const [exists] = await this.dataset.table(tableName).exists();
    return exists;
  }

  /** Return the column names currently present in the table. */
  async getTableColumns(tableName: string): Promise<string[]> {
    const [metadata] = await this.dataset.table(tableName).getMetadata();
    const fields: Array<{ name: string }> = metadata.schema?.fields ?? [];
    return fields.map((f) => f.name);
  }

  /**
   * Return existing columns with their normalized BigQuery type strings.
   * Used by the worker to detect type drift before applying schema changes.
   */
  async getTableColumnsWithTypes(
    tableName: string,
  ): Promise<Map<string, string>> {
    const [metadata] = await this.dataset.table(tableName).getMetadata();
    const fields: Array<{ name: string; type: string }> =
      metadata.schema?.fields ?? [];
    const result = new Map<string, string>();
    for (const f of fields) {
      result.set(f.name, normalizeBigQueryType(f.type));
    }
    return result;
  }

  /** Create a table using a fully-qualified name. */
  async createTable(table: SqlTableDef): Promise<void> {
    const qi = (id: string) => this.dialect.quoteIdentifier(id);
    const cols = table.columns
      .map((c) => {
        const notNull = c.isPrimaryKey ? " NOT NULL" : "";
        return `  ${qi(c.name)} ${c.sqlType}${notNull}`;
      })
      .join(",\n");

    const ddl = `CREATE TABLE IF NOT EXISTS ${this.fqn(table.tableName)} (\n${cols}\n);`;
    await this.bigquery.query({ query: ddl });
  }

  /** Add columns to an existing table using a fully-qualified name. */
  async addColumns(tableName: string, columns: SqlColumn[]): Promise<void> {
    const qi = (id: string) => this.dialect.quoteIdentifier(id);
    for (const c of columns) {
      const stmt = `ALTER TABLE ${this.fqn(tableName)} ADD COLUMN ${qi(c.name)} ${c.sqlType};`;
      await this.bigquery.query({ query: stmt });
    }
  }

  /** Append rows via BigQuery streaming insert. */
  async insertRows(
    tableName: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.dataset.table(tableName).insert(rows);
  }

  /**
   * Upsert rows using a MERGE DML statement.
   *
   * Builds a source table from inline SELECT … UNION ALL rows and merges
   * into the target on the given primary key.
   */
  async upsertRows(
    tableName: string,
    rows: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    if (rows.length === 0) return;

    const allKeys = Object.keys(rows[0]!);
    const nonPkCols = allKeys.filter((k) => k !== primaryKey);
    const qi = (id: string) => this.dialect.quoteIdentifier(id);

    // Build inline source: SELECT val AS col, … UNION ALL SELECT …
    const selects = rows.map((row, i) => {
      const values = allKeys
        .map((k) => {
          const aliased =
            i === 0
              ? `${this.escapeValue(row[k])} AS ${qi(k)}`
              : this.escapeValue(row[k]);
          return aliased;
        })
        .join(", ");
      return `SELECT ${values}`;
    });

    const source = selects.join(" UNION ALL\n    ");

    // UPDATE SET clause (non-PK columns).
    // Note: when __sync_version is present we still update it so the row
    // tracks the latest applied version.
    const updateSet = nonPkCols
      .map((c) => `T.${qi(c)} = S.${qi(c)}`)
      .join(", ");

    // INSERT columns / values
    const insertCols = allKeys.map((c) => qi(c)).join(", ");
    const insertVals = allKeys.map((c) => `S.${qi(c)}`).join(", ");

    // Out-of-order protection: only UPDATE when the incoming version is
    // strictly greater than the stored one (NULL stored version means the
    // row pre-dates versioning → always update).
    const versionGuard = allKeys.includes(SYNC_VERSION_COLUMN)
      ? ` AND (T.${qi(SYNC_VERSION_COLUMN)} IS NULL OR S.${qi(SYNC_VERSION_COLUMN)} > T.${qi(SYNC_VERSION_COLUMN)})`
      : "";

    const query = [
      `MERGE ${this.fqn(tableName)} AS T`,
      `USING (\n    ${source}\n  ) AS S`,
      `ON T.${qi(primaryKey)} = S.${qi(primaryKey)}`,
      `WHEN MATCHED${versionGuard} THEN UPDATE SET ${updateSet}`,
      `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals});`,
    ].join("\n");

    await withRetry(() => this.bigquery.query({ query }));
  }

  /** Delete rows by primary-key values. */
  async deleteRows(
    tableName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;

    const qi = (id: string) => this.dialect.quoteIdentifier(id);
    const escaped = ids.map((v) => this.escapeValue(v)).join(", ");
    const query = `DELETE FROM ${this.fqn(tableName)} WHERE ${qi(primaryKey)} IN (${escaped});`;

    await withRetry(() => this.bigquery.query({ query }));
  }

  /** Execute a raw SQL statement (used by the migration manager). */
  async executeRaw(sql: string): Promise<void> {
    await this.bigquery.query({ query: sql });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** The BigQuery Dataset handle. */
  private get dataset() {
    return this.bigquery.dataset(this.datasetId);
  }

  /** Return the fully-qualified table reference (`` `dataset.table` ``). */
  private fqn(tableName: string): string {
    return `\`${this.datasetId}.${tableName}\``;
  }

  /** ISO 8601 timestamp pattern (e.g. 2026-03-29T20:59:27.394Z) */
  private static readonly ISO_TIMESTAMP_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  /** Escape a value for use as a SQL literal. */
  private escapeValue(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "string") {
      // ISO 8601 timestamps → TIMESTAMP literal (keeps type-safety with BQ TIMESTAMP columns)
      if (BigQueryAdapter.ISO_TIMESTAMP_RE.test(v)) {
        return `TIMESTAMP('${v}')`;
      }
      // Detect JSON strings (arrays/objects) → use PARSE_JSON for native JSON columns
      if (
        (v.startsWith("[") && v.endsWith("]")) ||
        (v.startsWith("{") && v.endsWith("}"))
      ) {
        return `PARSE_JSON('${v.replace(/'/g, "\\'")}')`;
      }
      return `'${v.replace(/'/g, "\\'")}'`;
    }
    // Objects / arrays → JSON
    return `PARSE_JSON('${JSON.stringify(v).replace(/'/g, "\\'")}')`;
  }
}
