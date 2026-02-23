/**
 * @module servers/pagination
 *
 * Creates a type-safe Firebase HTTPS function that exposes a paginated query
 * endpoint for any `ConfiguredRepository`.
 *
 * Features:
 *  - Cursor-based pagination (next / prev)
 *  - Optional relation population via `includes` field
 *  - Zod schema validation of query filters (must match repo model type)
 *  - CORS support
 *
 * @example
 * ```ts
 * import * as functions from "firebase-functions";
 * import { z } from "zod";
 * import { createPaginationFunction } from "@lpdjs/firestore-repo-service/servers/pagination";
 *
 * export const paginatePosts = functions.https.onRequest(
 *   createPaginationFunction(repos.posts, {
 *     schema: z.object({
 *       status: z.enum(["draft", "published"]).optional(),
 *       authorId: z.string().optional(),
 *     }),
 *     allowedIncludes: ["author"],
 *     defaultPageSize: 20,
 *   })
 * );
 * ```
 */

import type { ConfiguredRepository } from "../../src/repositories/types";
import type { RepositoryConfig } from "../../src/shared/types";
import type { HttpRequest, HttpResponse } from "../http-types";
import type {
  ExtractRelationalKeys,
  ExtractRepoModel,
  PaginationFunctionOptions,
} from "./types";
import { serializePaginationResult } from "./types";

// ---------------------------------------------------------------------------
// Tiny response helpers
// ---------------------------------------------------------------------------

function sendJson(res: HttpResponse, status: number, body: unknown): void {
  res.status(status).json(body);
}

function sendError(
  res: HttpResponse,
  status: number,
  message: string,
  details?: unknown,
): void {
  sendJson(res, status, { error: message, details: details ?? null });
}

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------

function applyCors(
  _req: HttpRequest,
  res: HttpResponse,
  cors: string | false,
): void {
  if (cors === false) return;
  res.set("Access-Control-Allow-Origin", cors);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ---------------------------------------------------------------------------
// Cursor helpers (base64url <-> plain doc id)
// ---------------------------------------------------------------------------

function decodeCursor(encoded: string | undefined): string | undefined {
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express-compatible request handler (Firebase HTTPS function body)
 * that serves paginated results for the given repository.
 *
 * @template TConfig - Repository configuration
 */
export function createPaginationFunction<
  TConfig extends RepositoryConfig<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
>(
  repo: ConfiguredRepository<TConfig>,
  options: PaginationFunctionOptions<
    ExtractRepoModel<ConfiguredRepository<TConfig>>
  >,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (req: any, res: any) => Promise<void> {
  type TModel = ExtractRepoModel<ConfiguredRepository<TConfig>>;
  type TRelKeys = ExtractRelationalKeys<ConfiguredRepository<TConfig>>;

  const {
    schema,
    defaultPageSize = 20,
    maxPageSize = 100,
    allowIncludes = true,
    allowedIncludes,
    cors = "*",
  } = options;

  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    // ── CORS pre-flight ────────────────────────────────────────────────────
    applyCors(req, res, cors);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    // ── Only accept GET / POST ─────────────────────────────────────────────
    if (req.method !== "GET" && req.method !== "POST") {
      sendError(res, 405, "Method not allowed. Use GET or POST.");
      return;
    }

    // ── Parse body (POST) or query string (GET) ────────────────────────────
    let raw: Record<string, unknown>;
    try {
      if (req.method === "POST") {
        raw =
          typeof req.body === "string"
            ? (JSON.parse(req.body) as Record<string, unknown>)
            : (req.body as Record<string, unknown>);
      } else {
        // GET: parameters come from the query string (JSON-encoded fields)
        raw = {};
        for (const [k, v] of Object.entries(req.query ?? {})) {
          try {
            raw[k] =
              typeof v === "string"
                ? v.startsWith("{") || v.startsWith("[")
                  ? (JSON.parse(v) as unknown)
                  : v
                : v;
          } catch {
            raw[k] = v;
          }
        }
      }
    } catch {
      sendError(res, 400, "Invalid JSON body.");
      return;
    }

    // ── Pagination params ──────────────────────────────────────────────────
    const pageSize = Math.min(
      maxPageSize,
      typeof raw.pageSize === "number" && raw.pageSize > 0
        ? raw.pageSize
        : defaultPageSize,
    );
    const direction = raw.direction === "prev" ? "prev" : "next";
    const cursorEncoded =
      typeof raw.cursor === "string" ? raw.cursor : undefined;

    // ── Validate user-supplied filters with the provided Zod schema ────────
    const filterParseResult = schema.safeParse(raw.filters ?? raw);
    if (!filterParseResult.success) {
      sendError(
        res,
        422,
        "Filter validation failed.",
        filterParseResult.error.flatten(),
      );
      return;
    }
    const validatedFilters = filterParseResult.data as Partial<TModel>;

    // ── Build where clauses from validated filters ─────────────────────────
    const whereFromFilters: [string, string, unknown][] = Object.entries(
      validatedFilters,
    )
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, "==", v]);

    // Explicit where clauses from the request (additive, on top of filters)
    const explicitWhere: [string, string, unknown][] = Array.isArray(raw.where)
      ? (raw.where as unknown[]).filter(
          (w): w is [string, string, unknown] =>
            Array.isArray(w) && w.length >= 3 && typeof w[0] === "string",
        )
      : [];

    const allWhere = [...whereFromFilters, ...explicitWhere] as [
      keyof TModel,
      any,
      any,
    ][];

    // ── OrderBy ────────────────────────────────────────────────────────────
    const orderBy = Array.isArray(raw.orderBy)
      ? (raw.orderBy as unknown[]).filter(
          (o): o is { field: string; direction?: "asc" | "desc" } =>
            typeof o === "object" && o !== null && "field" in (o as object),
        )
      : undefined;

    // ── Select ────────────────────────────────────────────────────────────
    const select = Array.isArray(raw.select)
      ? (raw.select as string[]).filter(
          (s): s is string => typeof s === "string",
        )
      : undefined;

    // ── Includes (relations) ──────────────────────────────────────────────
    let includes:
      | (string | { relation: string; select?: string[] })[]
      | undefined;
    if (allowIncludes && Array.isArray(raw.includes)) {
      includes = (raw.includes as unknown[]).filter(
        (inc): inc is string | { relation: string; select?: string[] } => {
          if (typeof inc === "string") {
            return !allowedIncludes || allowedIncludes.includes(inc);
          }
          if (
            typeof inc === "object" &&
            inc !== null &&
            "relation" in (inc as object)
          ) {
            const rel = (inc as { relation: string }).relation;
            return !allowedIncludes || allowedIncludes.includes(rel);
          }
          return false;
        },
      );
      if (includes.length === 0) includes = undefined;
    }

    // ── Cursor rehydration (fetch the DocumentSnapshot from its doc ID) ────
    let cursorSnapshot:
      | import("firebase-admin/firestore").DocumentSnapshot
      | undefined;
    if (cursorEncoded) {
      try {
        const decoded = decodeCursor(cursorEncoded);
        if (decoded) {
          const parsed = JSON.parse(decoded) as { docId?: string };
          if (parsed.docId) {
            const colRef =
              repo.ref as import("firebase-admin/firestore").CollectionReference;
            if (typeof (colRef as any).doc === "function") {
              cursorSnapshot = (await (colRef as any)
                .doc(parsed.docId)
                .get()) as import("firebase-admin/firestore").DocumentSnapshot;
            }
          }
        }
      } catch {
        // Invalid cursor — start from the beginning
      }
    }

    // ── Execute paginated query ────────────────────────────────────────────
    try {
      const paginateOptions = {
        pageSize,
        cursor: cursorSnapshot,
        direction,
        where: allWhere.length > 0 ? allWhere : undefined,
        orderBy: orderBy as
          | { field: keyof TModel; direction?: "asc" | "desc" }[]
          | undefined,
        select: select as (keyof TModel)[] | undefined,
        include: includes as
          | (
              | keyof TRelKeys
              | { relation: keyof TRelKeys & string; select?: string[] }
            )[]
          | undefined,
      };

      // Cast to any: `direction` exists at runtime in PaginationWithIncludeOptions
      // but is intentionally missing in the stricter public typed interface
      const result = await repo.query.paginate<any>(paginateOptions as any);
      const serialized = serializePaginationResult(result);
      sendJson(res, 200, serialized);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[PaginationFunction] Query error:", err);
      sendError(res, 500, "Internal error during pagination.", message);
    }
  };
}

export type {
  PaginationFunctionOptions,
  PaginationHttpResult,
  SerializedCursor,
} from "./types";
