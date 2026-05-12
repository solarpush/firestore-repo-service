/**
 * BigQuery type-name utilities used by the {@link BigQueryAdapter}.
 *
 * - {@link normalizeBigQueryType} canonicalises BigQuery type strings so that
 *   `INTEGER`/`INT64`, `FLOAT`/`FLOAT64`, `BOOLEAN`/`BOOL`, etc. compare
 *   equal during schema-drift detection.
 * - {@link isBigQueryTypeCompatible} returns whether a desired type can
 *   safely keep an existing column of another type — only widenings that
 *   BigQuery accepts via `ALTER COLUMN SET DATA TYPE` are allowed.
 */

/**
 * Canonicalise a BigQuery type name returned by `getMetadata().schema`
 * (which may use legacy aliases like `INTEGER` or `FLOAT`) so that it can
 * be compared against the type produced by `BigQueryDialect.mapType()`.
 */
export function normalizeBigQueryType(type: string): string {
  const upper = type.toUpperCase();
  switch (upper) {
    case "INTEGER":
      return "INT64";
    case "FLOAT":
      return "FLOAT64";
    case "BOOLEAN":
      return "BOOL";
    default:
      return upper;
  }
}

/**
 * Whether `desired` is the same as, or a safe widening of, `existing`.
 * The widenings mirror what BigQuery allows via
 * `ALTER COLUMN x SET DATA TYPE …` — see
 * https://cloud.google.com/bigquery/docs/managing-table-schemas#change_column_types
 */
export function isBigQueryTypeCompatible(
  existing: string,
  desired: string,
): boolean {
  const a = normalizeBigQueryType(existing);
  const b = normalizeBigQueryType(desired);
  if (a === b) return true;

  const widenings: Record<string, string[]> = {
    INT64: ["NUMERIC", "BIGNUMERIC", "FLOAT64"],
    NUMERIC: ["BIGNUMERIC", "FLOAT64"],
    DATE: ["DATETIME", "TIMESTAMP"],
    DATETIME: ["TIMESTAMP"],
  };
  return widenings[a]?.includes(b) ?? false;
}
