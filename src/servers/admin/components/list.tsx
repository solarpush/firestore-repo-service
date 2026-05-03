import { CellValue } from "./cell-value";
import { FilterBar } from "./filter-bar";
import { PageShell, renderHtml } from "./shell";
import type {
  ColumnMeta,
  FilterState,
  PageOptions,
  QueryError,
  RelationalFieldMeta,
  SortState,
} from "./types";

/** Shared helper — gather filter params into URLSearchParams. */
function baseParams(
  filters: FilterState[],
  sort?: SortState,
  pageSize?: number,
): URLSearchParams {
  const p = new URLSearchParams();
  for (const f of filters) {
    p.set(`fv_${f.field}`, f.value);
    p.set(`fo_${f.field}`, f.op);
  }
  if (sort) {
    p.set("ob", sort.field);
    p.set("od", sort.dir);
  }
  if (pageSize) p.set("ps", String(pageSize));
  return p;
}

/**
 * Build a query-string for pagination (preserves filters, sort, page-size).
 */
function paginationHref(
  filters: FilterState[],
  cursor: string,
  dir: "prev" | "next",
  sort?: SortState,
  pageSize?: number,
): string {
  const p = baseParams(filters, sort, pageSize);
  p.set("cursor", cursor);
  p.set("dir", dir);
  return `?${p.toString()}`;
}

/**
 * Build a query-string that toggles / cycles the sort on a column.
 * Clears the cursor so the user starts from page 1 of the new order.
 */
function sortHref(
  col: string,
  current: SortState | undefined,
  filters: FilterState[],
  pageSize?: number,
): string {
  const p = baseParams(filters, undefined, pageSize);
  if (current?.field === col) {
    if (current.dir === "asc") {
      p.set("ob", col);
      p.set("od", "desc");
    }
    // desc → no ob/od (back to default order)
  } else {
    p.set("ob", col);
    p.set("od", "asc");
  }
  return `?${p.toString()}`;
}

/** Build a query-string that changes page size (clears cursor). */
function pageSizeHref(
  newPs: number,
  filters: FilterState[],
  sort?: SortState,
): string {
  const p = baseParams(filters, sort, newPs);
  return `?${p.toString()}`;
}

export function renderListJsx(
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
  columnMeta: ColumnMeta[] = [],
  activeFilters: FilterState[] = [],
  allowDelete = false,
  relationalMeta: RelationalFieldMeta[] = [],
  sortState?: SortState,
  currentPageSize?: number,
  queryError?: QueryError,
  isGroup?: boolean,
): string {
  const listUrl = `${basePath}/${repoName}`;
  const createUrl = `${listUrl}/create`;

  return renderHtml(
    <PageShell
      opts={{
        title: repoName,
        breadcrumb: [
          { label: "Repositories", href: basePath },
          { label: repoName },
        ],
        basePath,
        flash,
      }}
    >
      {/* Filter panel */}
      {columnMeta.length > 0 && (
        <FilterBar
          action={listUrl}
          columnMeta={columnMeta}
          activeFilters={activeFilters}
          isGroup={isGroup}
        />
      )}

      {/* Query error alert (missing index or generic) */}
      {queryError && (
        <div
          role="alert"
          class={`alert ${queryError.type === "index" ? "alert-warning" : "alert-error"} mb-6 shadow-sm`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6 shrink-0 stroke-current"
            fill="none"
            viewBox="0 0 24 24"
          >
            {queryError.type === "index" ? (
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            ) : (
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            )}
          </svg>
          <div class="flex-1">
            <h3 class="font-bold">
              {queryError.type === "index"
                ? "Composite index required"
                : "Query failed"}
            </h3>
            <div class="text-sm">{queryError.message}</div>
          </div>
          {queryError.indexUrl && (
            <a
              href={queryError.indexUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-sm btn-outline"
            >
              Create Index →
            </a>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div class="flex flex-wrap justify-between items-center mb-4 gap-3">
        <div class="flex items-center gap-3">
          <span class="text-sm text-base-content/60">
            {docs.length} document{docs.length !== 1 && "s"}
          </span>
          {/* Rows-per-page */}
          <div class="flex items-center gap-1.5 text-sm text-base-content/60">
            <span>Rows</span>
            <div class="join">
              {[10, 25, 50, 100].map((ps) => (
                <a
                  key={ps}
                  href={pageSizeHref(ps, activeFilters, sortState)}
                  class={`join-item btn btn-xs ${currentPageSize === ps ? "btn-active btn-primary" : "btn-outline"}`}
                >
                  {ps}
                </a>
              ))}
            </div>
          </div>
        </div>
        <a href={createUrl} class="btn btn-primary btn-sm">
          + New
        </a>
      </div>

      {/* Table */}
      <div
        class="overflow-x-auto rounded-box border border-base-300 bg-base-100"
        data-frs-table-wrap
      >
        <table
          class="table table-sm w-full"
          data-frs-table
          data-frs-repo={repoName}
          data-frs-colcount={columns.length}
        >
          <thead>
            <tr class="bg-base-200/50">
              {[...columns].map((c, i) => {
                const isSorted = sortState?.field === c;
                const arrow = isSorted
                  ? sortState!.dir === "asc"
                    ? " ▲"
                    : " ▼"
                  : "";
                return (
                  <th
                    key={i}
                    class="text-xs font-semibold text-base-content/60 uppercase tracking-wide"
                  >
                    <a
                      href={sortHref(
                        c,
                        sortState,
                        activeFilters,
                        currentPageSize,
                      )}
                      class={`hover:text-base-content inline-flex items-center gap-0.5${isSorted ? " text-primary font-bold" : ""}`}
                    >
                      {c}
                      {arrow}
                    </a>
                  </th>
                );
              })}
              {relationalMeta.map((m, i) => (
                <th
                  key={`rel-${i}`}
                  class="text-xs font-semibold text-base-content/60 uppercase tracking-wide"
                >
                  {m.column}
                </th>
              ))}
              <th class="text-xs font-semibold text-base-content/60 uppercase tracking-wide text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 ? (
              <tr>
                <td
                  colspan={columns.length + relationalMeta.length + 1}
                  class="text-center py-16 text-base-content/40"
                >
                  No documents found
                </td>
              </tr>
            ) : (
              docs.map((doc, rowIdx) => {
                const id = String(doc["docId"] ?? doc["id"] ?? "");
                const editUrl = `${basePath}/${repoName}/${encodeURIComponent(id)}/edit`;
                const deleteUrl = `${basePath}/${repoName}/${encodeURIComponent(id)}/delete`;
                return (
                  <tr key={rowIdx} class="hover">
                    {columns.map((c, ci) => (
                      <td key={ci} class="align-top py-2">
                        <CellValue val={doc[c]} />
                      </td>
                    ))}
                    {relationalMeta.map((m, mi) => {
                      const rawVal = doc[m.key];
                      if (rawVal == null || rawVal === "") {
                        return <td key={`rel-${mi}`} class="py-2" />;
                      }
                      const href = `${basePath}/${m.targetRepo}?fv_${m.targetKey}=${encodeURIComponent(String(rawVal))}`;
                      return (
                        <td key={`rel-${mi}`} class="align-middle py-2">
                          <a
                            href={href}
                            class="btn btn-xs btn-ghost btn-outline"
                          >
                            {m.column}
                          </a>
                        </td>
                      );
                    })}
                    <td class="align-middle text-right whitespace-nowrap py-2">
                      <div class="flex gap-1 justify-end">
                        <a
                          href={editUrl}
                          class="btn btn-xs btn-outline"
                        >
                          Edit
                        </a>
                        {allowDelete && (
                          <form
                            method="post"
                            action={deleteUrl}
                            onsubmit="return confirm('Delete this document?')"
                          >
                            <button
                              type="submit"
                              class="btn btn-xs btn-error btn-outline"
                            >
                              Delete
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {(pagination.hasPrev || pagination.hasNext) && (
        <div class="flex justify-center items-center mt-6 gap-2">
          {pagination.hasPrev ? (
            <a
              href={paginationHref(
                activeFilters,
                pagination.prevCursor,
                "prev",
                sortState,
                currentPageSize,
              )}
              class="btn btn-sm btn-outline"
            >
              ← Previous
            </a>
          ) : (
            <button class="btn btn-sm btn-outline" disabled>
              ← Previous
            </button>
          )}
          {pagination.hasNext ? (
            <a
              href={paginationHref(
                activeFilters,
                pagination.nextCursor,
                "next",
                sortState,
                currentPageSize,
              )}
              class="btn btn-sm btn-outline"
            >
              Next →
            </a>
          ) : (
            <button class="btn btn-sm btn-outline" disabled>
              Next →
            </button>
          )}
        </div>
      )}
    </PageShell>,
  );
}
