/**
 * Admin UI renderer — HTML generation functions for the admin interface.
 * All HTML generation is done via JSX in components.tsx.
 * This file preserves the original public API for backward compatibility.
 *
 * @example
 * ```typescript
 * import {
 *   renderPage,
 *   renderDashboard,
 *   renderList,
 *   renderFormPage,
 *   ClientScript,
 *   CSS,
 * } from "@lpdjs/firestore-repo-service/servers/admin";
 *
 * // Render a complete page with shell
 * const html = renderPage("<h1>Content</h1>", {
 *   title: "My Admin",
 *   basePath: "/admin",
 * });
 *
 * // Render dashboard listing all repositories
 * const dashboard = renderDashboard(
 *   [
 *     { name: "users", path: "users", docCount: 150 },
 *     { name: "posts", path: "posts", docCount: 42 },
 *   ],
 *   "/admin"
 * );
 *
 * // Render document list with pagination
 * const list = renderList(
 *   "users",
 *   [{ docId: "1", name: "John" }, { docId: "2", name: "Jane" }],
 *   ["docId", "name"],
 *   "/admin",
 *   { hasPrev: false, hasNext: true, prevCursor: "", nextCursor: "abc123" },
 *   { type: "success", message: "User created!" }, // Optional flash
 *   [{ key: "name", label: "Name" }],              // Column metadata
 *   [{ field: "name", op: "==", value: "John" }],  // Active filters
 *   true,                                          // Allow delete
 *   [{ key: "docId", column: "Posts", targetRepo: "posts", targetKey: "userId", type: "many" }],
 *   { field: "name", direction: "asc" },           // Sort state
 *   25,                                            // Current page size
 * );
 *
 * // Render create/edit form page
 * const form = renderFormPage(
 *   "users",
 *   "<form>...</form>",
 *   "edit",
 *   "user-123",
 *   "/admin",
 *   { type: "error", message: "Validation failed" }
 * );
 * ```
 */

export { ClientScript } from "./components";
export type {
  ColumnMeta,
  FilterState,
  PageOptions,
  RelationalFieldMeta,
  SortState,
  WhereOp,
} from "./components";

/** @deprecated Styles come from DaisyUI CDN — no inline CSS needed */
export const CSS = "";

import type {
  ColumnMeta,
  FilterState,
  PageOptions,
  RelationalFieldMeta,
  SortState,
} from "./components";
import {
  renderDashboardJsx,
  renderFormPageJsx,
  renderListJsx,
  renderPageJsx,
} from "./components";

export function renderPage(content: string, opts: PageOptions): string {
  return renderPageJsx(content, opts);
}

export function renderDashboard(
  repos: { name: string; path: string; docCount?: number }[],
  basePath: string,
): string {
  return renderDashboardJsx(repos, basePath);
}

export function renderList(
  repoName: string,
  docs: Record<string, unknown>[],
  columns: string[],
  basePath: string,
  pagination: {
    hasPrev: boolean;
    hasNext: boolean;
    prevCursor: string;
    nextCursor: string;
  },
  flash?: PageOptions["flash"],
  columnMeta?: ColumnMeta[],
  activeFilters?: FilterState[],
  allowDelete?: boolean,
  relationalMeta?: RelationalFieldMeta[],
  sortState?: SortState,
  currentPageSize?: number,
): string {
  return renderListJsx(
    repoName,
    docs,
    columns,
    basePath,
    pagination,
    flash,
    columnMeta,
    activeFilters,
    allowDelete,
    relationalMeta,
    sortState,
    currentPageSize,
  );
}

export function renderFormPage(
  repoName: string,
  formHtml: string,
  mode: "create" | "edit",
  docId: string | null,
  basePath: string,
  flash?: PageOptions["flash"],
): string {
  return renderFormPageJsx(repoName, formHtml, mode, docId, basePath, flash);
}
