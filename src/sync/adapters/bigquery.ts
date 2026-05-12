/**
 * BigQuery adapter — streams Firestore changes to BigQuery via the
 * **Storage Write API** in CDC (Change Data Capture) mode.
 *
 * Why CDC over the legacy MERGE approach:
 *
 * - **No DML concurrency limit.** MERGE/DELETE DML is bounded by ≈ 2
 *   concurrent statements per table; busy collections triggered
 *   `Could not serialize access … due to concurrent update` errors.
 *   The Storage Write API has no such bound, so multiple Cloud Function
 *   instances can flush in parallel without conflicts.
 * - **Cheaper at scale.** Storage Write is roughly ~50% cheaper than
 *   legacy streaming inserts, and free for the first 2 TiB / month.
 * - **Same idempotency model.** Each row carries `_CHANGE_SEQUENCE_NUMBER`
 *   built from the existing `__sync_version` column, so out-of-order
 *   PubSub deliveries are merged correctly by BigQuery.
 *
 * Requirements:
 *
 * - Destination tables **must** declare a `PRIMARY KEY (...) NOT ENFORCED`
 *   constraint and be clustered on that key. {@link BigQueryAdapter.createTable}
 *   handles both for tables managed by this library.
 * - Tables should be created with `OPTIONS(max_staleness = INTERVAL …)`
 *   so the CDC merge runs in the background instead of on every read
 *   — see {@link BigQueryAdapterOptions.maxStaleness}.
 * - Service account needs `bigquery.tables.updateData` (e.g. via the
 *   `roles/bigquery.dataEditor` role).
 *
 * @example
 * ```ts
 * import { BigQuery } from "@google-cloud/bigquery";
 * import { BigQueryAdapter } from "@lpdjs/firestore-repo-service/sync/bigquery";
 *
 * const adapter = new BigQueryAdapter({
 *   projectId: "my-project",
 *   datasetId: "firestore_sync",
 *   bigquery: new BigQuery({ projectId: "my-project" }),
 *   maxStaleness: "INTERVAL 15 MINUTE",
 * });
 * ```
 */

import type { BigQuery } from "@google-cloud/bigquery";
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
}

/** Shared BigQuery dialect singleton. */
export const bigqueryDialect: SqlDialect = new BigQueryDialect();

// ---------------------------------------------------------------------------
// Storage Write API loader (kept loose so `@google-cloud/bigquery-storage`
// stays an OPTIONAL peer dep)
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

/**
 * Minimal structural shape of `@google-cloud/bigquery`'s `BigQuery` client
 * actually used by the adapter (`.dataset(...)` and `.query(...)`).
 *
 * Why structural and not just `BigQuery`: TypeScript treats classes with
 * private fields nominally. When a consumer's `node_modules` ends up with
 * a *second* copy of `@google-cloud/bigquery` (very common in workspace
 * setups, peer-dep dedup misses, monorepo nesting), the `BigQuery` they
 * import is *technically* a different type than the one this library's
 * `BigQuery` references — even though they are runtime-identical — and
 * assignment fails with `Types have separate declarations of a private
 * property '_universeDomain'`.
 *
 * Accepting a structural superset sidesteps the duplicate-install issue
 * without giving up type safety on the methods we actually call.
 */
export interface BigQueryLike {
  dataset(datasetId: string): {
    table(tableName: string): any;
    [key: string]: any;
  };
  query(options: { query: string; params?: unknown[] } | string): Promise<any>;
}

export interface BigQueryAdapterOptions {
  /** GCP project id that owns the dataset. */
  projectId: string;
  /** BigQuery dataset id. */
  datasetId: string;
  /**
   * BigQuery client used for DDL operations (createTable, addColumns,
   * getMetadata, executeRaw). Storage Write only handles inserts.
   *
   * Typed as the structural {@link BigQueryLike} (a superset satisfied by
   * `BigQuery` from `@google-cloud/bigquery`) to avoid TypeScript nominal
   * mismatches when the consumer's project ends up with two copies of
   * `@google-cloud/bigquery` in different `node_modules`. Pass
   * `new BigQuery({...})` from your own install — it satisfies this shape
   * structurally.
   */
  bigquery: BigQueryLike | BigQuery;
  /**
   * Optional pre-built Storage Write `WriterClient`. When omitted a new
   * one is created lazily on first use.
   */
  writerClient?: any;
  /**
   * Value passed to `OPTIONS(max_staleness = ...)` on `createTable`.
   *
   * **Why this matters**: in BigQuery CDC mode, Storage Write API rows
   * land in a delta buffer. They become visible to queries only after a
   * MERGE applies them to the base table. Two paths exist:
   *
   * - **Background MERGE** — runs periodically in the background, paid
   *   for as part of CDC pricing, and never blocks your readers.
   * - **Read-time MERGE** — every `SELECT` query merges the delta on the
   *   fly before returning. Always-fresh reads but every query pays for
   *   the merge work.
   *
   * `max_staleness` is the tolerated lag between a write and what reads
   * see. Setting it tells BigQuery: "background MERGE is fine if reads
   * are at most this stale". When the threshold is exceeded, the next
   * read triggers a one-shot merge.
   *
   * **The default `INTERVAL 0` means "always read-time merge"** — every
   * query forces a full merge of pending CDC writes. That makes reads
   * dramatically slower and more expensive on busy tables, so this
   * library defaults to a 15 minute window in production.
   *
   * Recommended:
   * - `INTERVAL 15 MINUTE` in production (good cost/freshness trade-off).
   * - `INTERVAL 1 MINUTE` in dev for quick visibility.
   * - Set to `null` to omit the option entirely (only do this when you
   *   know what you are doing — you'll likely hit slow & expensive reads).
   *
   * @default "INTERVAL 15 MINUTE"
   */
  maxStaleness?: string | null;
}

/**
 * BigQuery implementation of {@link SqlAdapter} using the Storage Write API
 * in CDC mode. See module-level docstring for the rationale.
 */
export class BigQueryAdapter implements SqlAdapter {
  private readonly bigquery: BigQueryLike;
  private readonly projectId: string;
  private readonly datasetId: string;
  private readonly maxStaleness: string | null;
  private writerClient: any;
  /** Cache of `{ writer, primaryKey }` per table name. */
  private readonly writers = new Map<
    string,
    { writer: any; primaryKey: string }
  >();

  constructor(options: BigQueryAdapterOptions) {
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
        `BigQueryAdapter requires a primary key on table \`${table.tableName}\` ` +
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
    // interpreted as NULL. We pass the maximum sequence number so the DELETE
    // wins over any concurrent UPSERT for the same key — tombstones from the
    // queue carry no `__sync_version` of their own.
    const cdc = ids.map((id) => ({
      [primaryKey]: id,
      _CHANGE_TYPE: "DELETE",
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

  /** ISO 8601 timestamp pattern (e.g. 2026-03-29T20:59:27.394Z) */
  private static readonly ISO_TIMESTAMP_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  /**
   * Convert a Date or epoch-millis number into the epoch-microseconds string
   * required by the Storage Write API for TIMESTAMP columns.
   *
   * The JSONWriter encodes through protobuf and a TIMESTAMP field is an
   * `int64`. Passing an ISO string would make `Long.fromString` throw
   * `interior hyphen` on the `-` characters.
   */
  private static toEpochMicros(d: Date): string {
    const ms = d.getTime();
    return (BigInt(ms) * 1000n).toString();
  }

  /** Convert JS values into shapes accepted by JSONWriter. */
  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue;
      if (v instanceof Date) {
        // TIMESTAMP column → int64 epoch micros (as string to preserve precision)
        out[k] = BigQueryAdapter.toEpochMicros(v);
      } else if (
        typeof v === "string" &&
        BigQueryAdapter.ISO_TIMESTAMP_RE.test(v)
      ) {
        // ISO timestamp produced upstream by `serializeDocument` (Firestore
        // Timestamp → ISO string) — convert to epoch micros for protobuf.
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) {
          out[k] = BigQueryAdapter.toEpochMicros(d);
        } else {
          out[k] = v;
        }
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
