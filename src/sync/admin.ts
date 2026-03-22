/**
 * Sync Admin — optional HTTP endpoint for inspecting and managing the
 * Firestore → SQL sync pipeline.
 *
 * Features (gated by `featuresFlag`):
 *  - **healthCheck** — compare expected Zod-derived columns vs actual SQL columns
 *  - **manualSync** — force re-sync all documents in a Firestore collection
 *  - **viewQueue** — inspect pending items in the per-repo SyncQueue
 *
 * @example
 * ```typescript
 * const sync = createFirestoreSync(repos, {
 *   // …deps, adapter, etc.
 *   admin: {
 *     auth: { type: "basic", username: "admin", password: "secret" },
 *     basePath: "/sync-admin",
 *     featuresFlag: { healthCheck: true, manualSync: true, viewQueue: true },
 *   },
 * });
 *
 * // The admin handler is automatically added:
 * export const { syncAdmin } = sync.functions;
 * ```
 */

import { z } from "zod";
import { MiniRouter } from "../servers/admin/router";
import type { AnyReq, AnyRes, RouteParams } from "../servers/admin/router";
import { zodSchemaToColumns } from "./schema-mapper";
import { serializeDocument } from "./serializer";
import type {
  RepoSyncConfig,
  SqlAdapter,
  SyncAdminConfig,
  SyncEvent,
} from "./types";
import type { SyncQueue } from "./queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Req = AnyReq & { params: RouteParams };

interface RepoInfo {
  name: string;
  schema: z.ZodObject<any> | null;
  documentKey: string;
  tableName: string;
  isGroup: boolean;
  repoCfg: RepoSyncConfig<string> | undefined;
  repo: any;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function page(title: string, basePath: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Sync Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;color:#1a1a1a;padding:2rem}
  a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
  h1{margin-bottom:1rem}h2{margin:1.5rem 0 .75rem}
  table{border-collapse:collapse;width:100%;margin-bottom:1rem}
  th,td{text-align:left;padding:.5rem .75rem;border:1px solid #d0d7de}
  th{background:#f6f8fa;font-weight:600}
  tr:nth-child(even){background:#fafbfc}
  .badge{display:inline-block;padding:.15rem .5rem;border-radius:1rem;font-size:.8rem;font-weight:600}
  .badge-ok{background:#dafbe1;color:#1a7f37}
  .badge-warn{background:#fff8c5;color:#9a6700}
  .badge-err{background:#ffebe9;color:#cf222e}
  .btn{display:inline-block;padding:.4rem 1rem;border:1px solid #d0d7de;border-radius:.375rem;
       background:#fff;cursor:pointer;font-size:.85rem;text-decoration:none;color:#1a1a1a}
  .btn:hover{background:#f3f4f6}.btn-primary{background:#0969da;color:#fff;border-color:#0969da}
  .btn-primary:hover{background:#0860ca}
  nav{margin-bottom:1.5rem}nav a{margin-right:1rem}
  .card{background:#fff;border:1px solid #d0d7de;border-radius:.5rem;padding:1.25rem;margin-bottom:1rem}
  pre{background:#f6f8fa;padding:1rem;border-radius:.375rem;overflow-x:auto;font-size:.85rem}
  .muted{color:#656d76;font-size:.85rem}
</style>
</head><body>
<nav><a href="${basePath}/">← Dashboard</a></nav>
<h1>${title}</h1>
${body}
</body></html>`;
}

function sendHtml(res: AnyRes, html: string, status = 200): void {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").send(html);
}

function sendJson(res: AnyRes, data: unknown, status = 200): void {
  res.status(status).set("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
}

function isJsonRequest(req: AnyReq): boolean {
  const accept = (req.headers?.["accept"] ?? "") as string;
  return accept.includes("application/json");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the sync admin HTTP handler.
 *
 * @param repoMapping - The configured repository mapping
 * @param adapter     - The SQL adapter (e.g. BigQueryAdapter)
 * @param queues      - Live queue map from the worker
 * @param handleMessage - Direct SyncEvent processor from the worker
 * @param config      - Admin-specific config (auth, basePath, features)
 * @param repoConfigs - Per-repo sync config (tableName, exclude, columnMap…)
 */
export function createSyncAdminServer(
  repoMapping: Record<string, any>,
  adapter: SqlAdapter,
  queues: Map<string, SyncQueue>,
  handleMessage: (event: SyncEvent) => Promise<void>,
  config: SyncAdminConfig,
  repoConfigs: Record<string, RepoSyncConfig<string> | undefined>,
): (req: any, res: any) => Promise<void> {
  const basePath = (config.basePath ?? "/").replace(/\/$/, "") || "";
  const features = config.featuresFlag ?? {};

  // Pre-compute repo info
  const repoInfos: RepoInfo[] = [];
  for (const [name, repo] of Object.entries(repoMapping)) {
    const repoCfg = repoConfigs[name];
    repoInfos.push({
      name,
      schema: (repo as any).schema ?? null,
      documentKey:
        (repo as any)._systemKeys?.[0] ?? (repo as any).documentKey ?? "docId",
      tableName: repoCfg?.tableName ?? name,
      isGroup: !!(repo as any)._isGroup,
      repoCfg,
      repo,
    });
  }

  const router = new MiniRouter();

  // -- Path normalisation middleware ----------------------------------------
  // In the Firebase Emulator, `req.path` is stripped of the function name
  // prefix, but `req.originalUrl` retains the full URL. When basePath is set,
  // we rewrite `req.path` so the router matches the registered patterns.
  if (basePath) {
    router.use((req, _res, next) => {
      const p = (req as any).path as string | undefined;
      // If req.path doesn't already start with basePath, try originalUrl
      if (p && !p.startsWith(basePath)) {
        const orig: string | undefined = (req as any).originalUrl;
        if (orig) {
          const idx = orig.indexOf(basePath);
          if (idx !== -1) {
            (req as any).path = orig.slice(idx);
          }
        }
      }
      next();
    });
  }

  // -- Auth middleware -----------------------------------------------------
  if (config.auth) {
    if (typeof config.auth === "function") {
      router.use(config.auth as any);
    } else {
      const realm = config.auth.realm ?? "Sync Admin";
      const expected =
        "Basic " +
        Buffer.from(`${config.auth.username}:${config.auth.password}`).toString(
          "base64",
        );
      router.use((req, res, next) => {
        const authorization =
          (req as any).headers?.["authorization"] ?? "";
        if (authorization !== expected) {
          res
            .status(401)
            .set("WWW-Authenticate", `Basic realm="${realm}"`)
            .set("Content-Type", "text/plain")
            .send("Unauthorized");
          return;
        }
        next();
      });
    }
  }

  // -- Dashboard ----------------------------------------------------------
  router.get(`${basePath}/`, (req, res) => {
    const rows = repoInfos
      .map((r) => {
        const links: string[] = [];
        if (features.healthCheck)
          links.push(
            `<a class="btn" href="${basePath}/${r.name}/health">Health</a>`,
          );
        if (features.manualSync)
          links.push(
            `<a class="btn btn-primary" href="${basePath}/${r.name}/force-sync">Force Sync</a>`,
          );
        return `<tr>
          <td><strong>${r.name}</strong></td>
          <td>${r.tableName}</td>
          <td>${r.isGroup ? '<span class="badge badge-warn">group</span>' : '<span class="badge badge-ok">collection</span>'}</td>
          <td>${r.schema ? "✓" : "✗"}</td>
          <td>${links.join(" ")}</td>
        </tr>`;
      })
      .join("\n");

    const queueLink = features.viewQueue
      ? `<p><a class="btn" href="${basePath}/queues">View Queues</a></p>`
      : "";

    const html = page(
      "Sync Dashboard",
      basePath,
      `<div class="card">
        <table>
          <thead><tr><th>Repository</th><th>Table</th><th>Type</th><th>Schema</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${queueLink}
      </div>`,
    );
    sendHtml(res, html);
  });
  router.get(`${basePath}`, (_req, res) => {
    res.status(302).set("Location", `${basePath}/`).send("");
  });

  // -- Health Check -------------------------------------------------------
  if (features.healthCheck) {
    router.get(`${basePath}/:repoName/health`, async (req: Req, res) => {
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendHtml(res, page("Not Found", basePath, `<p>Unknown repo: ${req.params.repoName}</p>`), 404);
        return;
      }
      if (!info.schema) {
        sendHtml(
          res,
          page("Health Check", basePath, `<p class="badge badge-warn">No Zod schema attached to "${info.name}"</p>`),
        );
        return;
      }

      const expectedCols = zodSchemaToColumns(info.schema, adapter.dialect, {
        primaryKey: info.documentKey,
        exclude: info.repoCfg?.exclude,
        columnMap: info.repoCfg?.columnMap as Record<string, string> | undefined,
      });

      let actualCols: string[] = [];
      let tableExists = false;
      let error: string | null = null;
      try {
        tableExists = await adapter.tableExists(info.tableName);
        if (tableExists) {
          actualCols = await adapter.getTableColumns(info.tableName);
        }
      } catch (e: any) {
        error = e?.message ?? String(e);
      }

      const actualSet = new Set(actualCols);
      const expectedSet = new Set(expectedCols.map((c) => c.name));

      const missing = expectedCols.filter((c) => !actualSet.has(c.name));
      const extra = actualCols.filter((c) => !expectedSet.has(c));
      const matched = expectedCols.filter((c) => actualSet.has(c.name));

      const isHealthy = tableExists && missing.length === 0 && !error;

      if (isJsonRequest(req)) {
        sendJson(res, {
          repo: info.name,
          table: info.tableName,
          tableExists,
          healthy: isHealthy,
          error,
          columns: {
            expected: expectedCols.map((c) => ({
              name: c.name,
              type: c.sqlType,
              nullable: c.nullable,
              isPrimaryKey: c.isPrimaryKey,
            })),
            actual: actualCols,
            matched: matched.map((c) => c.name),
            missing: missing.map((c) => ({
              name: c.name,
              type: c.sqlType,
            })),
            extra,
          },
        });
        return;
      }

      const statusBadge = isHealthy
        ? '<span class="badge badge-ok">Healthy</span>'
        : '<span class="badge badge-err">Unhealthy</span>';

      const colRows = expectedCols
        .map((c) => {
          const status = actualSet.has(c.name)
            ? '<span class="badge badge-ok">OK</span>'
            : '<span class="badge badge-err">MISSING</span>';
          return `<tr><td>${c.name}</td><td>${c.sqlType}</td><td>${c.nullable ? "Yes" : "No"}</td><td>${c.isPrimaryKey ? "✓" : ""}</td><td>${status}</td></tr>`;
        })
        .join("\n");

      const extraRows = extra
        .map(
          (c) =>
            `<tr><td>${c}</td><td colspan="3" class="muted">not in schema</td><td><span class="badge badge-warn">EXTRA</span></td></tr>`,
        )
        .join("\n");

      const html = page(
        `Health: ${info.name}`,
        basePath,
        `<div class="card">
          <p>Table: <code>${info.tableName}</code> ${!tableExists ? '<span class="badge badge-err">NOT FOUND</span>' : statusBadge}</p>
          ${error ? `<p class="badge badge-err">Error: ${error}</p>` : ""}
          <h2>Columns</h2>
          <table>
            <thead><tr><th>Column</th><th>SQL Type</th><th>Nullable</th><th>PK</th><th>Status</th></tr></thead>
            <tbody>${colRows}${extraRows}</tbody>
          </table>
        </div>`,
      );
      sendHtml(res, html);
    });
  }

  // -- Force Sync ---------------------------------------------------------
  if (features.manualSync) {
    // GET  — confirmation page
    router.get(`${basePath}/:repoName/force-sync`, (req: Req, res) => {
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendHtml(res, page("Not Found", basePath, `<p>Unknown repo: ${req.params.repoName}</p>`), 404);
        return;
      }

      const html = page(
        `Force Sync: ${info.name}`,
        basePath,
        `<div class="card">
          <p>This will read <strong>all</strong> documents from the <code>${info.name}</code> Firestore collection
          and upsert them into the <code>${info.tableName}</code> SQL table.</p>
          <p class="muted" style="margin:.75rem 0">This may take a while for large collections.</p>
          <form method="POST" action="${basePath}/${info.name}/force-sync">
            <button type="submit" class="btn btn-primary">Start Force Sync</button>
          </form>
        </div>`,
      );
      sendHtml(res, html);
    });

    // POST — execute
    router.post(`${basePath}/:repoName/force-sync`, async (req: Req, res) => {
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendJson(res, { error: `Unknown repo: ${req.params.repoName}` }, 404);
        return;
      }

      // Use the repository's collectionGroup or collection query
      const collRef = info.repo.ref;
      if (!collRef) {
        sendJson(res, { error: `No collection reference for "${info.name}"` }, 400);
        return;
      }

      let synced = 0;
      let errors = 0;
      const batchSize = 500;
      let query = collRef.limit(batchSize);
      let lastDoc: any = null;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const paginatedQuery = lastDoc
            ? query.startAfter(lastDoc)
            : query;
          const snapshot = await paginatedQuery.get();
          if (snapshot.empty) break;

          for (const doc of snapshot.docs) {
            const data = doc.data() as Record<string, unknown>;
            const docId = String(
              data[info.documentKey] ?? doc.id,
            );
            const serialized = serializeDocument(data, {
              exclude: info.repoCfg?.exclude,
              columnMap: info.repoCfg?.columnMap,
            });

            try {
              await handleMessage({
                operation: "UPSERT",
                repoName: info.name,
                docId,
                data: serialized,
                timestamp: new Date().toISOString(),
              });
              synced++;
            } catch {
              errors++;
            }
          }

          lastDoc = snapshot.docs[snapshot.docs.length - 1];
          if (snapshot.docs.length < batchSize) break;
        }

        // Flush the queue for this repo
        const queue = queues.get(info.name);
        if (queue) await queue.flush();
      } catch (e: any) {
        if (isJsonRequest(req)) {
          sendJson(res, { error: e?.message ?? String(e), synced, errors }, 500);
          return;
        }
        sendHtml(
          res,
          page(
            `Force Sync: ${info.name}`,
            basePath,
            `<div class="card">
              <p class="badge badge-err">Error: ${e?.message ?? String(e)}</p>
              <p>Synced ${synced} docs before failure (${errors} errors).</p>
            </div>`,
          ),
          500,
        );
        return;
      }

      if (isJsonRequest(req)) {
        sendJson(res, { repo: info.name, table: info.tableName, synced, errors });
        return;
      }

      const html = page(
        `Force Sync: ${info.name}`,
        basePath,
        `<div class="card">
          <p class="badge badge-ok">Complete</p>
          <p>Synced <strong>${synced}</strong> documents to <code>${info.tableName}</code>.</p>
          ${errors > 0 ? `<p class="badge badge-warn">${errors} error(s)</p>` : ""}
        </div>`,
      );
      sendHtml(res, html);
    });
  }

  // -- View Queues --------------------------------------------------------
  if (features.viewQueue) {
    router.get(`${basePath}/queues`, (req, res) => {
      const queueData: Array<{
        repo: string;
        table: string;
        pending: number;
      }> = [];

      for (const info of repoInfos) {
        const q = queues.get(info.name);
        queueData.push({
          repo: info.name,
          table: info.tableName,
          pending: q ? q.size : 0,
        });
      }

      if (isJsonRequest(req)) {
        sendJson(res, { queues: queueData });
        return;
      }

      const rows = queueData
        .map(
          (q) =>
            `<tr><td>${q.repo}</td><td>${q.table}</td><td>${q.pending === 0 ? '<span class="badge badge-ok">0</span>' : `<span class="badge badge-warn">${q.pending}</span>`}</td></tr>`,
        )
        .join("\n");

      const html = page(
        "Sync Queues",
        basePath,
        `<div class="card">
          <table>
            <thead><tr><th>Repository</th><th>Table</th><th>Pending</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`,
      );
      sendHtml(res, html);
    });
  }

  // -- Request handler ----------------------------------------------------
  return async (req: any, res: any): Promise<void> => {
    await router.handle(req, res);
  };
}
