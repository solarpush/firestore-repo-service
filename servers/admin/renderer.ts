/**
 * Admin UI renderer — thin re-export layer.
 * All HTML generation is now done via JSX in components.tsx.
 * This file preserves the original public API for backward compatibility.
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
