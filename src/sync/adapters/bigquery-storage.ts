/**
 * BigQuery **Storage Write API** adapter (CDC mode).
 *
 * Unlike {@link BigQueryAdapter} which uses MERGE/DELETE DML, this adapter
 * streams rows through the Storage Write API and lets BigQuery apply the
 * Change Data Capture semantics in the background.
 *
 * Why use this:
 *
 * - **No DML concurrency limit.** The legacy adapter is bounded by ≈ 2
 *   concurrent MERGE/DELETE statements per table; busy collections trigger
 *   `Could not serialize access … due to concurrent update` errors. The
 *   Storage Write API has no such bound, so multiple Cloud Function
 *   instances can flush in parallel without conflicts.
 * - **Cheaper at scale.** Storage Write API is roughly ~50% cheaper than
 *   legacy streaming inserts, and free for the first 2 TiB / month.
 * - **Same idempotency model.** Each row carries `_CHANGE_SEQUENCE_NUMBER`
 *   built from the existing `__sync_version` column, so out-of-order
 *   deliveries are merged correctly by BigQuery.
 *
 * Requirements:
 *
 * - The destination tables **must** declare a `PRIMARY KEY (...) NOT
 *   ENFORCED` constraint and be clustered on that key.
 *   {@link createTable} handles both for tables managed by this library.
 * - Tables should be created with `OPTIONS(max_staleness = INTERVAL …)`
 *   so the CDC merge runs in the background and queries see fresh data.
 * - Service account needs `bigquery.tables.updateData` (e.g. via the
 *   `roles/bigquery.dataEditor` role).
 *
 * @example
 * ```ts
 * import { BigQuery } from "@google-cloud/bigquery";
 * import { BigQueryStorageAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery-storage";
 *
 * const adapter = new BigQueryStorageAdapter({
 *   projectId: "my-project",
 *   datasetId: "firestore_sync",
 *   bigquery: new BigQuery({ projectId: "my-project" }),
 *   maxStaleness: "INTERVAL 15 MINUTE",
 * });
 * ```
 */

import { SYNC_VERSION_COLUMN } from "../constants";
import type {
  SqlAdapter,
  SqlColumn,
  SqlDialect,
  SqlTableDef,
} from "../types";
import { bigqueryDialect } from "./bigquery";
import { normalizeBigQueryType } from "./bigquery-types";

// ---------------------------------------------------------------------------
// Types (kept loose so `@google-cloud/bigquery-storage` stays an OPTIONAL peer)
// ---------------------------------------------------------------------------

type StorageNs = {
  managedwriter: {
    WriterClient: new (opts?: any) => any;
    JSONWriter: new (params: { connection: any; protoDescriptor: any }) => any;
    DefaultStream: any;
  };
  adapt: {
    convertBigQuerySchemaToStorageTableSchema(schema: any): any;
    convertStorageSchemaToProto2Descriptor(
      schema: any,
      scope: string,
      ...opts: any[]
    ): any;
    withChangeType(): any;
    withChangeSequenceNumber(): any;
  };
};

let storageNsCache: StorageNs | null = null;
function loadStorageNs(): StorageNs {
  if (storageNsCache) return storageNsCache;
  // Lazy require so the library does not pull `@google-cloud/bigquery-storage`
  // unless this adapter is actually instantiated.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@google-cloud/bigquery-storage");
  storageNsCache = mod as StorageNs;
  return storageNsCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format `__sync_version` (Firestore commit timestamp in microseconds since
 * epoch) as the 16-character hex string required by `_CHANGE_SEQUENCE_NUMBER`.
 *
 * BigQuery compares sequence numbers lexicographically, so a fixed-width hex
 * representation is mandatory for correct ordering.
 */
function formatChangeSequenceNumber(version: unknown): string {
  let n: bigint;
  if (typeof version === "bigint") n = version;
  else if (typeof version === "number") n = BigInt(version);
  else if (typeof version === "string") n = BigInt(version);
  else n = 0n;
  if (n < 0n) n = 0n;
  return n.toString(16).padStart(16, "0");
}

/**
 * Returns true when the Storage Write append failed with a transient gRPC
 * status (UNAVAILABLE, DEADLINE_EXCEEDED, INTERNAL, ABORTED). Caller can
 * safely retry these.
 */
function isRetryableStorageError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number };
  // gRPC codes: 4=DEADLINE_EXCEEDED, 10=ABORTED, 13=INTERNAL, 14=UNAVAILABLE
  return e.code === 4 || e.code === 10 || e.code === 13 || e.code === 14;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 6,
  baseMs = 200,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryableStorageError(err) || attempt > maxRetries) throw err;
      const cap = baseMs * Math.pow(2, attempt);
      const delay = Math.random() * cap;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface BigQueryStorageAdapterOptions {
  /** GCP project id that owns the dataset. */
  projectId: string;
  /** BigQuery dataset id. */
  datasetId: string;
  /**
   * BigQuery client used for DDL operations (createTable, addColumns,
   * getMetadata, executeRaw). Storage Write only handles inserts.
   */
  bigquery: any;
  /**
   * Optional pre-built `WriterClient`. When omitted a new one is created on
   * first use.
   */
  writerClient?: any;
  /**
   * Value passed to `OPTIONS(max_staleness = ...)` on `createTable`.
   * Recommended: `INTERVAL 15 MINUTE` in production, `INTERVAL 1 MINUTE`
   * in development. Set to `null` to omit (BigQuery defaults to 0, which
   * forces a merge on every read and is **not** what you want).
   * @default "INTERVAL 15 MINUTE"
   */
  maxStaleness?: string | null;
}

/**
 * Storage Write API implementation of {@link SqlAdapter}.
 */
export class BigQueryStorageAdapter implements SqlAdapter {
  private readonly bigquery: any;
  private readonly projectId: string;
  private readonly datasetId: string;
  private readonly maxStaleness: string | null;
  private writerClient: any;
  /** Cache of `{ writer, primaryKey }` per table name. */
  private readonly writers = new Map<
    string,
    { writer: any; primaryKey: string }
  >();

  constructor(options: BigQueryStorageAdapterOptions) {
    this.bigquery = options.bigquery;
    this.projectId = options.projectId;
    this.datasetId = options.datasetId;
    this.maxStaleness =
      options.maxStaleness === undefined
        ? "INTERVAL 15 MINUTE"
        : options.maxStaleness;
    this.writerClient = options.writerClient;
  }

  get dialect(): SqlDialect {
    return bigqueryDialect;
  }

  // -------- DDL (delegated to @google-cloud/bigquery) ----------------------

  async tableExists(tableName: string): Promise<boolean> {
    const [exists] = await this.dataset.table(tableName).exists();
    return exists;
  }

  async getTableColumns(tableName: string): Promise<string[]> {
    const [metadata] = await this.dataset.table(tableName).getMetadata();
    const fields: Array<{ name: string }> = metadata.schema?.fields ?? [];
    return fields.map((f) => f.name);
  }

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

  async createTable(table: SqlTableDef): Promise<void> {
    const qi = (id: string) => this.dialect.quoteIdentifier(id);
    const pk = table.columns.find((c) => c.isPrimaryKey)?.name;
    if (!pk) {
      throw new Error(
        `BigQueryStorageAdapter requires a primary key on table \`${table.tableName}\` ` +
          `(Storage Write CDC mode needs PRIMARY KEY NOT ENFORCED).`,
      );
    }
    const cols = table.columns
      .map((c) => {
        const notNull = c.isPrimaryKey ? " NOT NULL" : "";
        return `  ${qi(c.name)} ${c.sqlType}${notNull}`;
      })
      .join(",\n");

    const opts: string[] = [];
    if (this.maxStaleness !== null) {
      opts.push(`max_staleness = ${this.maxStaleness}`);
    }
    const optionsClause =
      opts.length > 0 ? `\nOPTIONS(${opts.join(", ")})` : "";

    const ddl =
      `CREATE TABLE IF NOT EXISTS ${this.fqn(table.tableName)} (\n${cols},\n` +
      `  PRIMARY KEY (${qi(pk)}) NOT ENFORCED\n)` +
      `\nCLUSTER BY ${qi(pk)}` +
      `${optionsClause};`;

    await this.bigquery.query({ query: ddl });
  }

  async addColumns(tableName: string, columns: SqlColumn[]): Promise<void> {
    const qi = (id: string) => this.dialect.quoteIdentifier(id);
    for (const c of columns) {
      const stmt = `ALTER TABLE ${this.fqn(tableName)} ADD COLUMN ${qi(c.name)} ${c.sqlType};`;
      await this.bigquery.query({ query: stmt });
    }
  }

  async executeRaw(sql: string): Promise<void> {
    await this.bigquery.query({ query: sql });
  }

  /**
   * Invalidate the cached writer for a table. Called by the worker after
   * `addColumns` so the next append rebuilds the proto descriptor against
   * the new schema.
   */
  onSchemaChange(tableName: string): void {
    const cached = this.writers.get(tableName);
    if (cached) {
      try {
        cached.writer.close();
      } catch {
        // ignore — connection may already be torn down
      }
      this.writers.delete(tableName);
    }
  }

  // -------- Inserts (Storage Write API) -----------------------------------

  async insertRows(
    tableName: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // Plain inserts have no PK matching, but in CDC mode every row needs a
    // _CHANGE_TYPE. We treat them as UPSERT.
    const writer = await this.getOrCreateWriter(tableName);
    const cdc = rows.map((row) => ({
      ...this.normalizeRow(row),
      _CHANGE_TYPE: "UPSERT",
      _CHANGE_SEQUENCE_NUMBER: formatChangeSequenceNumber(
        row[SYNC_VERSION_COLUMN],
      ),
    }));
    await this.appendWithRetry(tableName, writer, cdc);
  }

  async upsertRows(
    tableName: string,
    rows: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const writer = await this.getOrCreateWriter(tableName, primaryKey);
    const cdc = rows.map((row) => ({
      ...this.normalizeRow(row),
      _CHANGE_TYPE: "UPSERT",
      _CHANGE_SEQUENCE_NUMBER: formatChangeSequenceNumber(
        row[SYNC_VERSION_COLUMN],
      ),
    }));
    await this.appendWithRetry(tableName, writer, cdc);
  }

  async deleteRows(
    tableName: string,
    primaryKey: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const writer = await this.getOrCreateWriter(tableName, primaryKey);
    // Storage Write CDC requires a value for every NOT-NULL column (the PK)
    // and a `_CHANGE_TYPE`. Other columns may be omitted; missing values are
    // interpreted as NULL by default.
    const cdc = ids.map((id) => ({
      [primaryKey]: id,
      _CHANGE_TYPE: "DELETE",
      // No reliable version on plain deletes (the queue does not carry one
      // for tombstones), so we pass an all-zero sequence number meaning
      // "apply only if newer than every previous UPSERT" only when explicit
      // versioning is enabled. For tombstones we instead use the maximum
      // value to make sure the DELETE wins over any concurrent UPSERT for
      // the same key.
      _CHANGE_SEQUENCE_NUMBER: "ffffffffffffffff",
    }));
    await this.appendWithRetry(tableName, writer, cdc);
  }

  // -------- Internal helpers ----------------------------------------------

  private get dataset() {
    return this.bigquery.dataset(this.datasetId);
  }

  private fqn(tableName: string): string {
    return `\`${this.datasetId}.${tableName}\``;
  }

  /** Convert JS values into shapes accepted by JSONWriter. */
  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue;
      if (v instanceof Date) {
        // Storage Write expects ISO strings or epoch micros for TIMESTAMP
        out[k] = v.toISOString();
      } else if (typeof v === "object" && v !== null) {
        // JSON columns: serialise nested objects/arrays
        out[k] = JSON.stringify(v);
      } else if (typeof v === "bigint") {
        out[k] = v.toString();
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private async appendWithRetry(
    tableName: string,
    writer: any,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    await withRetry(async () => {
      try {
        const pending = writer.appendRows(rows);
        await pending.getResult();
      } catch (err) {
        // On certain errors (schema drift, broken connection) drop the
        // cached writer so the next call rebuilds it.
        this.onSchemaChange(tableName);
        throw err;
      }
    });
  }

  private async getOrCreateWriter(
    tableName: string,
    primaryKey?: string,
  ): Promise<any> {
    const cached = this.writers.get(tableName);
    if (cached) {
      if (primaryKey && cached.primaryKey !== primaryKey) {
        // PK changed — invalidate and rebuild
        this.onSchemaChange(tableName);
      } else {
        return cached.writer;
      }
    }

    const ns = loadStorageNs();
    if (!this.writerClient) {
      this.writerClient = new ns.managedwriter.WriterClient({
        projectId: this.projectId,
      });
    }

    const [metadata] = await this.dataset.table(tableName).getMetadata();
    const bqSchema = { fields: metadata.schema?.fields ?? [] };
    if (!primaryKey) {
      // Try to recover PK from table constraints if available
      const tableConstraintsPK =
        metadata.tableConstraints?.primaryKey?.columns?.[0];
      primaryKey = tableConstraintsPK ?? bqSchema.fields[0]?.name;
    }

    const storageSchema =
      ns.adapt.convertBigQuerySchemaToStorageTableSchema(bqSchema);
    const protoDescriptor = ns.adapt.convertStorageSchemaToProto2Descriptor(
      storageSchema,
      "Row",
      ns.adapt.withChangeType(),
      ns.adapt.withChangeSequenceNumber(),
    );

    const destinationTable = `projects/${this.projectId}/datasets/${this.datasetId}/tables/${tableName}`;
    // Pass `DefaultStream` as `streamId` (not `streamType`): the `_default`
    // stream is implicit on every table, so the client must short-circuit to
    // `${destinationTable}/streams/_default` instead of calling
    // `createWriteStream({ type: DEFAULT })` which BigQuery rejects with
    // `Unable to create a stream with type TYPE_UNSPECIFIED`.
    const connection = await this.writerClient.createStreamConnection({
      streamId: ns.managedwriter.DefaultStream,
      destinationTable,
    });

    const writer = new ns.managedwriter.JSONWriter({
      connection,
      protoDescriptor,
    });

    this.writers.set(tableName, { writer, primaryKey: primaryKey ?? "" });
    return writer;
  }

  /** Close all open writer connections. Useful for graceful shutdown. */
  async close(): Promise<void> {
    for (const { writer } of this.writers.values()) {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
    this.writers.clear();
    if (this.writerClient && typeof this.writerClient.close === "function") {
      try {
        this.writerClient.close();
      } catch {
        /* ignore */
      }
    }
  }
}
