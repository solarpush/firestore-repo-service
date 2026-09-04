/**
 * Sync Admin — optional HTTP endpoint for inspecting and managing the
 * Firestore → SQL sync pipeline.
 *
 * Features (gated by `featuresFlag`):
 *  - **healthCheck** — compare expected Zod-derived columns vs actual SQL columns
 *  - **manualSync** — force re-sync all documents in a Firestore collection
 *
 * @example
 * ```typescript
 * const sync = createFirestoreSync(repos, {
 *   // …deps, adapter, etc.
 *   admin: {
 *     auth: { type: "basic", username: "admin", password: "secret" },
 *     featuresFlag: { healthCheck: true, manualSync: true },
 *   },
 * });
 *
 * export const adminsync = onRequest(sync.adminHandler!);
 * ```
 */

import { z } from "zod";
import type { AnyReq, AnyRes, RouteParams } from "../servers/admin/router";
import { MiniRouter } from "../servers/admin/router";
import { isAuthExtension } from "../servers/auth";
import { makeLazyRepo } from "../repositories/factory";
import { getLinkBase } from "../servers/utils/link-base";
import type { SyncQueue } from "./queue";
import { serializeDocument } from "./serializer";
import type {
  adminsyncConfig,
  PubSubClientDep,
  RepoSyncConfig,
  SyncAdapter,
  SyncEvent,
  SyncHealthResult,
} from "./types";

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
  adapters: SyncAdapter[];
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function page(title: string, linkBase: string, body: string): string {
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
<nav><a href="${linkBase}/">← Dashboard</a></nav>
<h1>${title}</h1>
${body}
</body></html>`;
}

function sendHtml(res: AnyRes, html: string, status = 200): void {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").send(html);
}

function sendJson(res: AnyRes, data: unknown, status = 200): void {
  res
    .status(status)
    .set("Content-Type", "application/json")
    .send(JSON.stringify(data, null, 2));
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
 */
export function createadminsyncServer(
  repoMapping: Record<string, any>,
  adapterOrAdapters: SyncAdapter | SyncAdapter[],
  queues: Map<string, SyncQueue>,
  handleMessage: (event: SyncEvent) => Promise<void>,
  config: adminsyncConfig,
  repoConfigs: Record<string, RepoSyncConfig<string> | undefined>,
  pubsub?: PubSubClientDep,
  topicPrefix?: string,
): (req: any, res: any) => Promise<void> {
  const basePath = (config.basePath ?? "/").replace(/\/$/, "") || "";
  const features = config.featuresFlag ?? {};

  const adapters: SyncAdapter[] = Array.isArray(adapterOrAdapters)
    ? adapterOrAdapters
    : [adapterOrAdapters];

  const rawMapping: Record<string, any> | undefined = (repoMapping as any)
    ?.rawMapping;
  const repoInfos: RepoInfo[] = [];

  for (const name of Object.keys(repoMapping)) {
    const repoCfg = repoConfigs[name];
    const repo = rawMapping
      ? makeLazyRepo(rawMapping[name], () => (repoMapping as Record<string, any>)[name])
      : (repoMapping as Record<string, any>)[name];

    const activeAdapters = repoCfg?.adapters && repoCfg.adapters.length > 0
      ? adapters.filter((a) => repoCfg.adapters!.includes(a.name))
      : adapters;

    repoInfos.push({
      name,
      schema: (repo as any).schema ?? null,
      documentKey:
        (repo as any)._systemKeys?.[0] ?? (repo as any).documentKey ?? "docId",
      tableName: repoCfg?.tableName ?? name,
      isGroup: !!(repo as any)._isGroup,
      repoCfg,
      repo,
      adapters: activeAdapters,
    });
  }

  const router = new MiniRouter();

  // -- Auth middleware -----------------------------------------------------
  if (config.auth) {
    if (isAuthExtension(config.auth)) {
      const ext = config.auth;
      for (const route of ext.routes) {
        const mountPath = `${basePath}${route.path}`;
        if (route.method === "GET") router.get(mountPath, route.handler);
        else router.post(mountPath, route.handler);
      }
      router.use(ext.middleware);
    } else if (typeof config.auth === "function") {
      router.use(config.auth as any);
    } else {
      const realm = config.auth.realm ?? "Sync Admin";
      const expected =
        "Basic " +
        Buffer.from(`${config.auth.username}:${config.auth.password}`).toString(
          "base64",
        );
      router.use((req, res, next) => {
        const authorization = (req as any).headers?.["authorization"] ?? "";
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
    const lb = getLinkBase(req, basePath);
    const rows = repoInfos
      .map((r) => {
        const links: string[] = [];
        if (features.healthCheck)
          links.push(`<a class="btn" href="${lb}/${r.name}/health">Health</a>`);
        if (features.manualSync)
          links.push(
            `<a class="btn btn-primary" href="${lb}/${r.name}/force-sync">Force Sync</a>`,
          );
        const adapterBadges = r.adapters
          .map((a) => `<span class="badge badge-ok">${a.name}</span>`)
          .join(" ");

        return `<tr>
          <td><strong>${r.name}</strong></td>
          <td>${r.tableName}</td>
          <td>${adapterBadges || '<span class="badge badge-warn">none</span>'}</td>
          <td>${r.isGroup ? '<span class="badge badge-warn">group</span>' : '<span class="badge badge-ok">collection</span>'}</td>
          <td>${r.schema ? "✓" : "✗"}</td>
          <td>${links.join(" ")}</td>
        </tr>`;
      })
      .join("\n");

    const configCheckLink = features.configCheck
      ? `<p style="margin-top:.5rem"><a class="btn" href="${lb}/config-check">⚙ Config Check</a></p>`
      : "";

    const html = page(
      "Sync Dashboard",
      lb,
      `<div class="card">
        <table>
          <thead><tr><th>Repository</th><th>Target Name</th><th>Adapters</th><th>Type</th><th>Schema</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${configCheckLink}
      </div>`,
    );
    sendHtml(res, html);
  });
  router.get(`${basePath}`, (req, res) => {
    const lb = getLinkBase(req, basePath);
    res.status(302).set("Location", `${lb}/`).send("");
  });

  // -- Health Check -------------------------------------------------------
  if (features.healthCheck) {
    router.get(`${basePath}/:repoName/health`, async (req: Req, res) => {
      const lb = getLinkBase(req, basePath);
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendHtml(
          res,
          page("Not Found", lb, `<p>Unknown repo: ${req.params.repoName}</p>`),
          404,
        );
        return;
      }

      const results: Array<{
        adapterName: string;
        health: SyncHealthResult;
      }> = [];

      for (const adapter of info.adapters) {
        if (typeof adapter.healthCheck === "function") {
          const h = await adapter.healthCheck({
            targetName: info.tableName,
            primaryKey: info.documentKey,
            schema: info.schema ?? undefined,
            repoConfig: info.repoCfg,
          });
          results.push({ adapterName: adapter.name, health: h });
        } else {
          try {
            const exists = await adapter.targetExists(info.tableName);
            results.push({
              adapterName: adapter.name,
              health: {
                healthy: exists,
                targetName: info.tableName,
                targetExists: exists,
                error: exists ? null : `Target "${info.tableName}" does not exist`,
              },
            });
          } catch (e: any) {
            results.push({
              adapterName: adapter.name,
              health: {
                healthy: false,
                targetName: info.tableName,
                targetExists: false,
                error: e?.message ?? String(e),
              },
            });
          }
        }
      }

      const allHealthy =
        results.length > 0 && results.every((r) => r.health.healthy);

      if (isJsonRequest(req)) {
        sendJson(res, {
          repo: info.name,
          targetName: info.tableName,
          healthy: allHealthy,
          adapters: results.map((r) => ({
            name: r.adapterName,
            ...r.health,
          })),
        });
        return;
      }

      const renderAdapterCard = (r: {
        adapterName: string;
        health: SyncHealthResult;
      }) => {
        const { adapterName, health } = r;
        const statusBadge = health.healthy
          ? '<span class="badge badge-ok">Healthy</span>'
          : '<span class="badge badge-err">Unhealthy</span>';

        let extraContent = "";
        const details = health.details as any;
        if (details?.expected && Array.isArray(details.expected)) {
          const expectedCols = details.expected;
          const actualSet = new Set(details.actual ?? []);
          const extraCols = (details.extra ?? []) as string[];
          const colRows = expectedCols
            .map((c: any) => {
              const status = actualSet.has(c.name)
                ? '<span class="badge badge-ok">OK</span>'
                : '<span class="badge badge-err">MISSING</span>';
              return `<tr><td>${c.name}</td><td>${c.type}</td><td>${c.nullable ? "Yes" : "No"}</td><td>${c.isPrimaryKey ? "✓" : ""}</td><td>${status}</td></tr>`;
            })
            .join("\n");
          const extraRows = extraCols
            .map(
              (c: string) =>
                `<tr><td>${c}</td><td colspan="3" class="muted">not in schema</td><td><span class="badge badge-warn">EXTRA</span></td></tr>`,
            )
            .join("\n");

          extraContent = `<h2>Columns</h2>
            <table>
              <thead><tr><th>Column</th><th>SQL Type</th><th>Nullable</th><th>PK</th><th>Status</th></tr></thead>
              <tbody>${colRows}${extraRows}</tbody>
            </table>`;
        } else if (details?.numberOfDocuments !== undefined) {
          extraContent = `<h2>Index Stats</h2>
            <table>
              <tr><th>Documents Count</th><td>${details.numberOfDocuments}</td></tr>
              <tr><th>Indexing in Progress</th><td>${details.isIndexing ? '<span class="badge badge-warn">Yes</span>' : '<span class="badge badge-ok">No</span>'}</td></tr>
              <tr><th>Primary Key</th><td><code>${details.primaryKey ?? "default"}</code></td></tr>
            </table>`;
        }

        return `<div class="card" style="margin-top:1rem">
          <h2>Adapter: <code>${adapterName}</code> ${statusBadge}</h2>
          <p>Target: <code>${health.targetName}</code> ${!health.targetExists ? '<span class="badge badge-err">NOT FOUND</span>' : ""}</p>
          ${health.error ? `<p class="badge badge-err" style="margin-top:.5rem">Error: ${health.error}</p>` : ""}
          ${extraContent}
        </div>`;
      };

      const html = page(
        `Health: ${info.name}`,
        lb,
        `<div class="card">
          <p>Overall status for <strong>${info.name}</strong>: ${allHealthy ? '<span class="badge badge-ok">Healthy</span>' : '<span class="badge badge-err">Issues detected</span>'}</p>
        </div>
        ${results.map(renderAdapterCard).join("\n")}`,
      );
      sendHtml(res, html);
    });
  }

  // -- Force Sync ---------------------------------------------------------
  if (features.manualSync) {
    router.get(`${basePath}/:repoName/force-sync`, (req: Req, res) => {
      const lb = getLinkBase(req, basePath);
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendHtml(
          res,
          page("Not Found", lb, `<p>Unknown repo: ${req.params.repoName}</p>`),
          404,
        );
        return;
      }

      const html = page(
        `Force Sync: ${info.name}`,
        lb,
        `<div class="card">
          <p>This will read <strong>all</strong> documents from the <code>${info.name}</code> Firestore collection
          and upsert them into all active target storage adapters (${info.adapters.map((a) => a.name).join(", ")}).</p>
          <p class="muted" style="margin:.75rem 0">This may take a while for large collections.</p>
          <form method="POST" action="${lb}/${info.name}/force-sync">
            <button type="submit" class="btn btn-primary">Start Force Sync</button>
          </form>
        </div>`,
      );
      sendHtml(res, html);
    });

    router.post(`${basePath}/:repoName/force-sync`, async (req: Req, res) => {
      const lb = getLinkBase(req, basePath);
      const info = repoInfos.find((r) => r.name === req.params.repoName);
      if (!info) {
        sendJson(res, { error: `Unknown repo: ${req.params.repoName}` }, 404);
        return;
      }

      const collRef = info.repo.ref;
      if (!collRef) {
        sendJson(
          res,
          { error: `No collection reference for "${info.name}"` },
          400,
        );
        return;
      }

      let synced = 0;
      let errors = 0;
      const errorSamples: string[] = [];
      const batchSize = 500;
      const query = collRef.limit(batchSize);
      let lastDoc: any = null;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const paginatedQuery = lastDoc ? query.startAfter(lastDoc) : query;
          const snapshot = await paginatedQuery.get();
          if (snapshot.empty) break;

          for (const doc of snapshot.docs) {
            const data = doc.data() as Record<string, unknown>;
            const docId = String(data[info.documentKey] ?? doc.id);
            const serialized = serializeDocument(data, {
              exclude: info.repoCfg?.exclude,
              columnMap: info.repoCfg?.columnMap,
              flat: info.repoCfg?.flat,
              transformDoc: info.repoCfg?.transformDoc,
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
            } catch (e: any) {
              errors++;
              const msg = e?.message ?? String(e);
              console.error(
                `[ForceSync:${info.name}] doc=${docId} failed:`,
                e,
              );
              if (errorSamples.length < 5) errorSamples.push(`${docId}: ${msg}`);
            }
          }

          lastDoc = snapshot.docs[snapshot.docs.length - 1];
          if (snapshot.docs.length < batchSize) break;
        }

        // Flush all queues for this repo across its adapters
        for (const adapter of info.adapters) {
          const queueKey = `${info.name}:${adapter.name}`;
          const queue = queues.get(queueKey) ?? queues.get(info.name);
          if (queue) await queue.flush();
        }
      } catch (e: any) {
        if (isJsonRequest(req)) {
          sendJson(
            res,
            { error: e?.message ?? String(e), synced, errors },
            500,
          );
          return;
        }
        sendHtml(
          res,
          page(
            `Force Sync: ${info.name}`,
            lb,
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
        sendJson(res, {
          repo: info.name,
          table: info.tableName,
          synced,
          errors,
          ...(errorSamples.length > 0 && { errorSamples }),
        });
        return;
      }

      const errorBlock =
        errorSamples.length > 0
          ? `<details style="margin-top:1rem"><summary>First ${errorSamples.length} error(s)</summary>
              <pre style="white-space:pre-wrap">${errorSamples
                .map((s) => s.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`))
                .join("\n\n")}</pre></details>`
          : "";

      const html = page(
        `Force Sync: ${info.name}`,
        lb,
        `<div class="card">
          <p class="badge ${errors > 0 ? "badge-warn" : "badge-ok"}">${errors > 0 ? "Completed with errors" : "Complete"}</p>
          <p>Synced <strong>${synced}</strong> documents to targets (${info.adapters.map((a) => a.name).join(", ")}).</p>
          ${errors > 0 ? `<p class="badge badge-warn">${errors} error(s)</p>` : ""}
          ${errorBlock}
        </div>`,
      );
      sendHtml(res, html);
    });
  }

  // -- Config Check -------------------------------------------------------
  if (features.configCheck) {
    router.get(`${basePath}/config-check`, async (req, res) => {
      const lb = getLinkBase(req, basePath);
      const project =
        process.env["GCLOUD_PROJECT"] ??
        process.env["GOOGLE_CLOUD_PROJECT"] ??
        process.env["GCP_PROJECT"] ??
        "unknown";
      const consoleBase = `https://console.cloud.google.com`;
      const tPrefix = topicPrefix ?? "firestore-sync";

      interface CheckResult {
        name: string;
        category: "bigquery" | "meilisearch" | "pubsub" | "firestore" | "storage";
        status: "ok" | "error" | "warn";
        message: string;
        fix?: { gcloud?: string; console?: string; hint?: string };
      }

      const checks: CheckResult[] = [];

      // Check each configured adapter
      for (const adapter of adapters) {
        if (adapter.name === "bigquery") {
          try {
            await adapter.targetExists("__nonexistent_health_check__");
            checks.push({
              name: "BigQuery API",
              category: "bigquery",
              status: "ok",
              message: "BigQuery API is reachable",
            });
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            const msgLower = msg.toLowerCase();
            const isApiDisabled =
              msgLower.includes("disabled") ||
              msgLower.includes("has not been used") ||
              msgLower.includes("accessnotconfigured");
            const isPermission =
              msgLower.includes("permission") ||
              msg.includes("403") ||
              msgLower.includes("access denied");
            const isProjectNotFound =
              msgLower.includes("project") && msgLower.includes("not found");
            const isNotFound =
              msgLower.includes("not found") || msg.includes("404");

            if (isApiDisabled) {
              checks.push({
                name: "BigQuery API",
                category: "bigquery",
                status: "error",
                message: "BigQuery API is not enabled",
                fix: {
                  gcloud: `gcloud services enable bigquery.googleapis.com --project=${project}`,
                  console: `${consoleBase}/apis/library/bigquery.googleapis.com?project=${project}`,
                },
              });
            } else if (isProjectNotFound) {
              checks.push({
                name: "BigQuery Project",
                category: "bigquery",
                status: "error",
                message: msg,
                fix: {
                  hint:
                    "The GCP project does not exist or the credentials don't have access to it.",
                  console: `${consoleBase}/home/dashboard`,
                },
              });
            } else if (isPermission) {
              checks.push({
                name: "BigQuery API",
                category: "bigquery",
                status: "error",
                message: `Permission denied: ${msg}`,
                fix: {
                  hint: "Grant the service account BigQuery Data Editor + BigQuery Job User roles",
                  console: `${consoleBase}/iam-admin/iam?project=${project}`,
                },
              });
            } else if (isNotFound) {
              checks.push({
                name: "BigQuery Dataset",
                category: "bigquery",
                status: "error",
                message: `Dataset not found: ${msg}`,
                fix: {
                  hint: "Create the dataset first",
                  gcloud: `bq mk --dataset ${project}:YOUR_DATASET_ID`,
                  console: `${consoleBase}/bigquery?project=${project}`,
                },
              });
            } else {
              checks.push({
                name: "BigQuery API",
                category: "bigquery",
                status: "ok",
                message:
                  "BigQuery API is reachable (table lookup returned expected error)",
              });
            }
          }
        } else if (adapter.name === "meilisearch" || typeof (adapter as any).checkConnection === "function") {
          try {
            const conn = typeof (adapter as any).checkConnection === "function"
              ? await (adapter as any).checkConnection()
              : { healthy: await adapter.targetExists("__nonexistent__") };
            checks.push({
              name: "Meilisearch API",
              category: "meilisearch",
              status: conn.healthy ? "ok" : "error",
              message: conn.healthy
                ? `Meilisearch is reachable${conn.version ? ` (v${conn.version})` : ""}`
                : `Meilisearch connection error: ${conn.error ?? "unknown"}`,
              ...(conn.error && {
                fix: {
                  hint: "Ensure Meilisearch is running and host/apiKey options are valid.",
                },
              }),
            });
          } catch (e: any) {
            checks.push({
              name: "Meilisearch API",
              category: "meilisearch",
              status: "error",
              message: `Meilisearch error: ${e?.message ?? String(e)}`,
            });
          }
        }
      }

      // Per-repo target existence
      for (const info of repoInfos) {
        for (const adapter of info.adapters) {
          const category = adapter.name === "bigquery" ? "bigquery" : adapter.name === "meilisearch" ? "meilisearch" : "storage";
          try {
            const exists = await adapter.targetExists(info.tableName);
            checks.push({
              name: `[${adapter.name}] Target: ${info.tableName}`,
              category,
              status: exists ? "ok" : "warn",
              message: exists
                ? `Target \`${info.tableName}\` exists`
                : `Target \`${info.tableName}\` does not exist yet`,
              ...(!exists && {
                fix: {
                  hint: `Target will be auto-created on first sync if autoMigrate is enabled.`,
                },
              }),
            });
          } catch (e: any) {
            checks.push({
              name: `[${adapter.name}] Target: ${info.tableName}`,
              category,
              status: "error",
              message: e?.message ?? String(e),
            });
          }
        }
      }

      // --- Pub/Sub checks ---
      if (pubsub) {
        for (const info of repoInfos) {
          const topicName = `${tPrefix}-${info.name}`;
          try {
            const topic = (pubsub as any).topic(topicName);
            if (typeof topic.exists === "function") {
              const [exists] = await topic.exists();
              checks.push({
                name: `Topic: ${topicName}`,
                category: "pubsub",
                status: exists ? "ok" : "error",
                message: exists
                  ? `Topic \`${topicName}\` exists`
                  : `Topic \`${topicName}\` does not exist`,
                ...(!exists && {
                  fix: {
                    gcloud: `gcloud pubsub topics create ${topicName} --project=${project}`,
                    console: `${consoleBase}/cloudpubsub/topic/list?project=${project}`,
                  },
                }),
              });
            } else {
              checks.push({
                name: `Topic: ${topicName}`,
                category: "pubsub",
                status: "warn",
                message:
                  "Cannot verify topic existence (PubSub client doesn't expose .exists())",
                fix: {
                  gcloud: `gcloud pubsub topics create ${topicName} --project=${project}`,
                  console: `${consoleBase}/cloudpubsub/topic/list?project=${project}`,
                },
              });
            }
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            const isApiDisabled =
              msg.includes("disabled") || msg.includes("has not been used");
            checks.push({
              name: isApiDisabled ? "Pub/Sub API" : `Topic: ${topicName}`,
              category: "pubsub",
              status: "error",
              message: isApiDisabled ? "Pub/Sub API is not enabled" : msg,
              fix: isApiDisabled
                ? {
                    gcloud: `gcloud services enable pubsub.googleapis.com --project=${project}`,
                    console: `${consoleBase}/apis/library/pubsub.googleapis.com?project=${project}`,
                  }
                : {
                    gcloud: `gcloud pubsub topics create ${topicName} --project=${project}`,
                    console: `${consoleBase}/cloudpubsub/topic/list?project=${project}`,
                  },
            });
            if (isApiDisabled) break;
          }
        }
      } else {
        checks.push({
          name: "Pub/Sub Client",
          category: "pubsub",
          status: "warn",
          message: "PubSub client not available for config check",
        });
      }

      // --- JSON response ---
      if (isJsonRequest(req)) {
        const allOk = checks.every((c) => c.status === "ok");
        sendJson(res, { project, healthy: allOk, checks });
        return;
      }

      // --- HTML response ---
      const statusIcon = (s: string) =>
        s === "ok"
          ? '<span class="badge badge-ok">OK</span>'
          : s === "warn"
            ? '<span class="badge badge-warn">WARN</span>'
            : '<span class="badge badge-err">ERROR</span>';

      const grouped = {
        bigquery: checks.filter((c) => c.category === "bigquery"),
        meilisearch: checks.filter((c) => c.category === "meilisearch"),
        pubsub: checks.filter((c) => c.category === "pubsub"),
        firestore: checks.filter((c) => c.category === "firestore"),
        storage: checks.filter((c) => c.category === "storage"),
      };

      const renderSection = (title: string, items: CheckResult[]) => {
        if (items.length === 0) return "";
        const rows = items
          .map((c) => {
            let fixHtml = "";
            if (c.fix) {
              const parts: string[] = [];
              if (c.fix.hint) parts.push(`<p class="muted">${c.fix.hint}</p>`);
              if (c.fix.gcloud) parts.push(`<pre>$ ${c.fix.gcloud}</pre>`);
              if (c.fix.console)
                parts.push(
                  `<p><a href="${c.fix.console}" target="_blank">Open GCP Console →</a></p>`,
                );
              fixHtml = `<div style="margin-top:.5rem">${parts.join("")}</div>`;
            }
            return `<tr>
              <td>${statusIcon(c.status)}</td>
              <td><strong>${c.name}</strong><br><span class="muted">${c.message}</span>${fixHtml}</td>
            </tr>`;
          })
          .join("\n");
        return `<h2>${title}</h2>
          <table><thead><tr><th style="width:80px">Status</th><th>Check</th></tr></thead>
          <tbody>${rows}</tbody></table>`;
      };

      const allOk = checks.every((c) => c.status === "ok");
      const overallBadge = allOk
        ? '<span class="badge badge-ok">All checks passed</span>'
        : '<span class="badge badge-warn">Some issues found</span>';

      const html = page(
        "Config Check",
        lb,
        `<div class="card">
          <p>Project: <code>${project}</code> ${overallBadge}</p>
          ${renderSection("BigQuery", grouped.bigquery)}
          ${renderSection("Meilisearch", grouped.meilisearch)}
          ${renderSection("Pub/Sub", grouped.pubsub)}
          ${renderSection("Other Targets", grouped.storage)}
          ${renderSection("Firestore", grouped.firestore)}
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

