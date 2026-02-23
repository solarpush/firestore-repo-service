import { CellValue } from "./cell-value";
import { FilterBar } from "./filter-bar";
import { PageShell, renderHtml } from "./shell";
import type { ColumnMeta, FilterState, PageOptions } from "./types";

/**
 * Build a query-string that preserves active filters and appends cursor/dir.
 */
function paginationHref(
  filters: FilterState[],
  cursor: string,
  dir: "prev" | "next",
): string {
  const params = new URLSearchParams();
  for (const f of filters) {
    params.set(`fv_${f.field}`, f.value);
    params.set(`fo_${f.field}`, f.op);
  }
  params.set("cursor", cursor);
  params.set("dir", dir);
  return `?${params.toString()}`;
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
        <div class="badge badge-neutral badge-lg">
          {docs.length} document(s)
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
              {[...columns, ""].map((c, i) => (
                <th
                  key={i}
                  class="text-xs font-semibold text-base-content/60 uppercase tracking-wide"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 ? (
              <tr>
                <td
                  colspan={columns.length + 1}
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
                    <td class="align-middle text-right whitespace-nowrap py-2">
                      <div class="flex gap-1 justify-end">
                        <a href={editUrl} class="btn btn-xs btn-outline">
                          Edit
                        </a>
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
            href={paginationHref(activeFilters, pagination.prevCursor, "prev")}
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
            href={paginationHref(activeFilters, pagination.nextCursor, "next")}
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
