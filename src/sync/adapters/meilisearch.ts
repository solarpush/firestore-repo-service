/**
 * Meilisearch adapter — streams Firestore changes to Meilisearch indexes.
 *
 * @example
 * ```ts
 * import { MeilisearchAdapter } from "@lpdjs/firestore-repo-service/sync/meilisearch";
 *
 * const adapter = new MeilisearchAdapter({
 *   host: "http://localhost:7700",
 *   apiKey: "masterKey",
 *   indexesSettings: {
 *     users: {
 *       filterableAttributes: ["role", "status", "createdAt"],
 *       sortableAttributes: ["createdAt", "name"],
 *       searchableAttributes: ["name", "email"],
 *     },
 *   },
 * });
 * ```
 */

import type { z } from "zod";
import { unflattenDocument } from "../serializer";
import type {
  ExtractRepoFieldPaths,
  RepoSyncConfig,
  SyncAdapter,
  SyncHealthResult,
} from "../types";

/**
 * Minimal structural shape of a Meilisearch client.
 */
export interface MeilisearchLike {
  index(indexUid: string): {
    addDocuments(documents: any[], options?: { primaryKey?: string }): Promise<any>;
    deleteDocuments(documentIds: string[] | number[]): Promise<any>;
    getStats(): Promise<any>;
    getRawInfo(): Promise<any>;
    updateSettings(settings: any): Promise<any>;
    [key: string]: any;
  };
  getIndex(indexUid: string): Promise<any>;
  createIndex(indexUid: string, options?: { primaryKey?: string }): Promise<any>;
  isHealthy?(): Promise<any>;
  health?(): Promise<any>;
  getVersion?(): Promise<any>;
}

export interface MeilisearchIndexSettings<Fields extends string = string> {
  filterableAttributes?: Fields[];
  sortableAttributes?: Fields[];
  searchableAttributes?: Fields[];
  rankingRules?: string[];
  stopWords?: string[];
  synonyms?: Record<string, string[]>;
  distinctAttribute?: Fields;
  [key: string]: any;
}

/**
 * Typed index settings map constrained to the repos in repository mapping `M`.
 * Field attributes autocomplete and check dot-notation nested paths.
 */
export type TypedMeilisearchIndexesSettings<M> = {
  [K in string & keyof M]?: MeilisearchIndexSettings<ExtractRepoFieldPaths<M[K]>>;
};

export interface MeilisearchAdapterOptions<
  M extends Record<string, any> = Record<string, any>,
> {
  /**
   * Host URL of the Meilisearch instance (e.g. `http://localhost:7700` or `https://ms-xxxx.meilisearch.io`).
   * Required if `client` is not provided.
   */
  host?: string;
  /**
   * API Key (e.g. master key or admin key) with permissions to read/write indexes.
   */
  apiKey?: string;
  /**
   * Existing pre-built Meilisearch client instance.
   */
  client?: MeilisearchLike | any;
  /**
   * Custom index settings per target index name (e.g. filterableAttributes, sortableAttributes).
   * When typed with repository mapping `M`, keys are constrained to repo names and attributes
   * are typed with dot-notation field paths.
   */
  indexesSettings?: string extends keyof M
    ? Record<string, MeilisearchIndexSettings>
    : TypedMeilisearchIndexesSettings<M>;
  /**
   * Whether to automatically unflatten double-underscore keys (`address__city` → `address.city`)
   * and parse stringified JSON arrays back into native arrays.
   * Default: `true`.
   */
  unflatten?: boolean;
  /**
   * Optional custom document transformation before indexing in Meilisearch.
   */
  transformDoc?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

/** Lazy-loader for the optional `meilisearch` peer dependency. */
function loadMeilisearchClient(options: MeilisearchAdapterOptions<any>): MeilisearchLike {
  if (options.client) return options.client;
  if (!options.host) {
    throw new Error(
      "MeilisearchAdapter requires either a `client` instance or a `host` option.",
    );
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MeiliSearch } = require("meilisearch");
    return new MeiliSearch({
      host: options.host,
      apiKey: options.apiKey,
    });
  } catch (err: any) {
    throw new Error(
      `Failed to load the "meilisearch" package. Please install it with:\n` +
        `  bun add meilisearch   # or npm install meilisearch\n` +
        `Original error: ${err?.message ?? String(err)}`,
    );
  }
}

/**
 * SyncAdapter implementation for Meilisearch.
 */
export class MeilisearchAdapter<
  M extends Record<string, any> = Record<string, any>,
> implements SyncAdapter {
  readonly name = "meilisearch";
  private _client: MeilisearchLike | null = null;
  private readonly options: MeilisearchAdapterOptions<M>;

  constructor(options: MeilisearchAdapterOptions<M>) {
    this.options = options;
    if (options.client) {
      this._client = options.client;
    }
  }

  /** Configured index settings */
  get indexesSettings(): MeilisearchAdapterOptions<M>["indexesSettings"] {
    return this.options.indexesSettings;
  }

  /** Resolved Meilisearch client instance. */
  get client(): MeilisearchLike {
    if (!this._client) {
      this._client = loadMeilisearchClient(this.options);
    }
    return this._client;
  }

  // ---------------------------------------------------------------------------
  // SyncAdapter Methods
  // ---------------------------------------------------------------------------

  async targetExists(targetName: string): Promise<boolean> {
    try {
      await this.client.getIndex(targetName);
      return true;
    } catch (err: any) {
      if (
        err?.code === "index_not_found" ||
        err?.cause?.code === "index_not_found" ||
        err?.statusCode === 404 ||
        err?.status === 404 ||
        err?.response?.status === 404 ||
        err?.cause?.status === 404 ||
        err?.cause?.statusCode === 404 ||
        err?.cause?.response?.status === 404
      ) {
        return false;
      }
      throw err;
    }
  }

  async upsert(
    targetName: string,
    items: Record<string, unknown>[],
    primaryKey: string,
  ): Promise<void> {
    if (items.length === 0) return;
    const shouldUnflatten = this.options.unflatten !== false;
    const docs = items.map((item) => {
      let doc = shouldUnflatten ? unflattenDocument(item) : item;
      if (typeof this.options.transformDoc === "function") {
        doc = this.options.transformDoc(doc);
      }
      return doc;
    });
    const index = this.client.index(targetName);
    await index.addDocuments(docs, { primaryKey });
  }

  async delete(
    targetName: string,
    _primaryKey: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const index = this.client.index(targetName);
    await index.deleteDocuments(ids);
  }

  async ensureTarget(options: {
    targetName: string;
    primaryKey: string;
    schema?: z.ZodObject<any>;
    exclude?: string[];
    columnMap?: Record<string, string>;
  }): Promise<void> {
    const { targetName, primaryKey } = options;
    const exists = await this.targetExists(targetName);
    if (!exists) {
      await this.client.createIndex(targetName, { primaryKey });
    }

    const settings = this.options.indexesSettings?.[targetName];
    if (settings) {
      const index = this.client.index(targetName);
      await index.updateSettings(settings);
    }
  }

  async healthCheck(options: {
    targetName: string;
    primaryKey: string;
    schema?: z.ZodObject<any>;
    repoConfig?: RepoSyncConfig<string>;
  }): Promise<SyncHealthResult> {
    const { targetName } = options;
    try {
      const exists = await this.targetExists(targetName);
      if (!exists) {
        return {
          healthy: false,
          targetName,
          targetExists: false,
          error: `Meilisearch index "${targetName}" does not exist`,
        };
      }
      const index = this.client.index(targetName);
      const stats = await index.getStats();
      const rawInfo = typeof index.getRawInfo === "function" ? await index.getRawInfo() : {};

      return {
        healthy: true,
        targetName,
        targetExists: true,
        error: null,
        details: {
          numberOfDocuments: stats?.numberOfDocuments ?? 0,
          isIndexing: stats?.isIndexing ?? false,
          fieldDistribution: stats?.fieldDistribution ?? {},
          primaryKey: rawInfo?.primaryKey ?? options.primaryKey,
        },
      };
    } catch (err: any) {
      return {
        healthy: false,
        targetName,
        targetExists: false,
        error: err?.message ?? String(err),
      };
    }
  }

  /** Verify overall connection and connectivity to the Meilisearch instance. */
  async checkConnection(): Promise<{
    healthy: boolean;
    version?: string;
    error?: string;
  }> {
    try {
      let isHealthy = true;
      if (typeof this.client.isHealthy === "function") {
        const res = await this.client.isHealthy();
        isHealthy = res?.status === "available" || res === true;
      } else if (typeof this.client.health === "function") {
        const res = await this.client.health();
        isHealthy = res?.status === "available" || res === true;
      }
      let version: string | undefined;
      if (typeof this.client.getVersion === "function") {
        const v = await this.client.getVersion();
        version = v?.pkgVersion;
      }
      return { healthy: isHealthy, version };
    } catch (e: any) {
      return { healthy: false, error: e?.message ?? String(e) };
    }
  }
}

/**
 * Type-safe factory helper for creating a Meilisearch adapter bound to a repository mapping `M`.
 * Provides full autocompletion and strict type checking on repository names and nested field paths.
 *
 * @example
 * ```ts
 * const adapter = defineMeilisearchAdapter<typeof repos>({
 *   client: createMeilisearchClient(),
 *   indexesSettings: {
 *     adminUsers: {
 *       searchableAttributes: ["docId", "baseUser.email"],
 *     },
 *   },
 * });
 * ```
 */
export function defineMeilisearchAdapter<
  M extends Record<string, any> = Record<string, any>,
>(options: MeilisearchAdapterOptions<M>): () => MeilisearchAdapter<M> {
  return () => new MeilisearchAdapter<M>(options);
}
