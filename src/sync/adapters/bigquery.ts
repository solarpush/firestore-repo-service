import type {
  SqlAdapter,
  SqlColumn,
  SqlDialect,
  SqlTableDef,
  LogicalType,
} from "../types";

// ---------------------------------------------------------------------------
// Dialect
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

  createTableDDL(table: SqlTableDef): string {
    const cols = table.columns
      .map((c) => {
        const notNull = c.isPrimaryKey ? " NOT NULL" : "";
        return `  ${this.quoteIdentifier(c.name)} ${c.sqlType}${notNull}`;
      })
      .join(",\n");

    return `CREATE TABLE IF NOT EXISTS ${this.quoteIdentifier(table.tableName)} (\n${cols}\n);`;
  }

  addColumnsDDL(tableName: string, columns: SqlColumn[]): string {
    return columns
      .map(
        (c) =>
          `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${this.quoteIdentifier(c.name)} ${c.sqlType};`,
      )
      .join("\n");
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

  /** Create a table using the dialect's DDL. */
  async createTable(table: SqlTableDef): Promise<void> {
    const ddl = this.dialect.createTableDDL(table);
    await this.bigquery.query({ query: ddl });
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
          const aliased = i === 0 ? `${this.escapeValue(row[k])} AS ${qi(k)}` : this.escapeValue(row[k]);
          return aliased;
        })
        .join(", ");
      return `SELECT ${values}`;
    });

    const source = selects.join(" UNION ALL\n    ");

    // UPDATE SET clause (non-PK columns)
    const updateSet = nonPkCols
      .map((c) => `T.${qi(c)} = S.${qi(c)}`)
      .join(", ");

    // INSERT columns / values
    const insertCols = allKeys.map((c) => qi(c)).join(", ");
    const insertVals = allKeys.map((c) => `S.${qi(c)}`).join(", ");

    const query = [
      `MERGE ${this.fqn(tableName)} AS T`,
      `USING (\n    ${source}\n  ) AS S`,
      `ON T.${qi(primaryKey)} = S.${qi(primaryKey)}`,
      `WHEN MATCHED THEN UPDATE SET ${updateSet}`,
      `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals});`,
    ].join("\n");

    await this.bigquery.query({ query });
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

    await this.bigquery.query({ query });
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

  /** Escape a value for use as a SQL literal. */
  private escapeValue(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "string") {
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
