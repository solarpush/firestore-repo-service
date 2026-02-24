import { CellValue } from "./cell-value";
import { FilterBar } from "./filter-bar";
import { PageShell, renderHtml } from "./shell";
import type {
  ColumnMeta,
  FilterState,
  PageOptions,
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
        />
      )}

      {/* Toolbar */}
      <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-3">
          <div class="badge badge-neutral badge-lg">
            {docs.length} document(s)
          </div>
          {/* Rows-per-page selector */}
          <div class="flex items-center gap-1 text-sm text-base-content/60">
            <span>Rows:</span>
            <div class="join">
              {[10, 25, 50, 100].map((ps) => (
                <a
                  key={ps}
                  href={pageSizeHref(ps, activeFilters, sortState)}
                  class={`join-item btn btn-xs ${currentPageSize === ps ? "btn-active" : "btn-outline"}`}
                >
                  {ps}
                </a>
              ))}
            </div>
          </div>
        </div>
        <a href={createUrl} class="btn btn-primary btn-sm">
          + New document
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
        >
          <thead>
            <tr>
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
                      href={sortHref(c, sortState, activeFilters, currentPageSize)}
                      class={`hover:text-base-content transition-colors${isSorted ? " text-primary" : ""}`}
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
              <th class="text-xs font-semibold text-base-content/60 uppercase tracking-wide" />
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 ? (
              <tr>
                <td
                  colspan={columns.length + relationalMeta.length + 1}
                  class="text-center py-16 text-base-content/40"
                >
                  No documents found.
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
                            class="btn btn-xs btn-ghost btn-outline gap-1"
                          >
                            {m.column} ↗
                          </a>
                        </td>
                      );
                    })}
                    <td class="align-middle text-right whitespace-nowrap py-2">
                      <div class="flex gap-1 justify-end">
                        <a href={editUrl} class="btn btn-xs btn-outline">
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
      <div class="flex justify-between items-center mt-4">
        {pagination.hasPrev ? (
          <a
            href={paginationHref(activeFilters, pagination.prevCursor, "prev", sortState, currentPageSize)}
            class="btn btn-sm btn-outline"
          >
            ← Previous
          </a>
        ) : (
          <button class="btn btn-sm btn-outline btn-disabled" disabled>
            ← Previous
          </button>
        )}
        {pagination.hasNext ? (
          <a
            href={paginationHref(activeFilters, pagination.nextCursor, "next", sortState, currentPageSize)}
            class="btn btn-sm btn-outline"
          >
            Next →
          </a>
        ) : (
          <button class="btn btn-sm btn-outline btn-disabled" disabled>
            Next →
          </button>
        )}
      </div>
    </PageShell>,
  );
}
