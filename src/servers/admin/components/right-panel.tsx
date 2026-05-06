import type { FC } from "hono/jsx";
import { CellValue } from "./cell-value";
import type { ExpectedType } from "./type-check";
import { expectedTypeOf, mismatchMessage, resolveAtPath } from "./type-check";

/** Slide-in right panel container — rendered once in the page shell, populated client-side. */
export const RightPanel: FC<{ basePath?: string }> = ({ basePath = "" }) => (
  <div
    class="fixed inset-0 z-[100] hidden pointer-events-none"
    data-frs-panel-root
    data-frs-base-path={basePath}
    aria-hidden="true"
  >
    {/* Backdrop */}
    <div
      class="absolute inset-0 bg-black/30 opacity-0 transition-opacity duration-200 pointer-events-auto"
      data-frs-panel-backdrop
    />
    {/* Panel — 50% on md+, full-width on mobile */}
    <aside
      class="absolute top-0 right-0 h-full w-full md:w-1/2 bg-base-100 shadow-2xl border-l border-base-300 translate-x-full transition-transform duration-200 pointer-events-auto flex flex-col"
      data-frs-panel
      role="dialog"
      aria-label="Relation preview"
    >
      <header class="flex items-center justify-between px-5 py-3 border-b border-base-300 bg-base-200/40 shrink-0">
        <h2
          class="font-semibold text-base truncate"
          data-frs-panel-title
        >
          Relation
        </h2>
        <button
          type="button"
          class="btn btn-sm btn-ghost btn-circle"
          data-frs-panel-close
          aria-label="Close panel"
        >
          ✕
        </button>
      </header>
      <div
        class="flex-1 overflow-auto p-5 text-sm"
        data-frs-panel-body
      >
        <div class="flex items-center justify-center py-12 text-base-content/40">
          <span class="loading loading-spinner loading-md" />
        </div>
      </div>
    </aside>
  </div>
);

// ---------------------------------------------------------------------------
// Server-rendered HTML fragments served at GET /:repoName/_panel
// (no <html>/<body> wrapper — they're injected into the panel body by JS)
// ---------------------------------------------------------------------------

/** Render the "one" relation preview: read-only field list + Edit/Open button. */
export function PanelOne({
  doc,
  repoName,
  basePath,
  schema,
  columns,
}: {
  doc: Record<string, unknown> | null;
  repoName: string;
  basePath: string;
  schema?: import("zod").ZodObject<any>;
  columns: string[];
}) {
  if (!doc) {
    return (
      <div class="text-center py-12 text-base-content/50">
        Document not found.
      </div>
    );
  }
  const id = String(doc["docId"] ?? doc["id"] ?? "");
  const editUrl = `${basePath}/${repoName}/${encodeURIComponent(id)}/edit`;
  const expectedTypes = buildExpectedMap(schema, columns);
  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs text-base-content/60">
          <span class="font-mono">{repoName}</span>
          <span class="opacity-50"> · </span>
          <span class="font-mono break-all">{id}</span>
        </div>
        <a href={editUrl} class="btn btn-sm btn-primary">
          Edit →
        </a>
      </div>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 border border-base-300 rounded-box p-4 bg-base-100">
        {columns.map((c) => {
          const val = doc[c];
          const expected = expectedTypes[c];
          const mismatch = expected ? mismatchMessage(expected, val) : null;
          return (
            <>
              <dt class="text-xs font-semibold text-base-content/60 uppercase tracking-wide pt-0.5">
                {c}
              </dt>
              <dd class="min-w-0">
                <CellValue val={val} mismatch={mismatch} />
              </dd>
            </>
          );
        })}
      </dl>
    </div>
  );
}

/** Render the "many" relation preview: full filtered list (compact table). */
export function PanelMany({
  docs,
  repoName,
  basePath,
  fk,
  fv,
  columns,
  schema,
  pagination,
}: {
  docs: Record<string, unknown>[];
  repoName: string;
  basePath: string;
  fk: string;
  fv: string;
  columns: string[];
  schema?: import("zod").ZodObject<any>;
  pagination: {
    hasPrev: boolean;
    hasNext: boolean;
    prevCursor: string;
    nextCursor: string;
    pageSize: number;
  };
}) {
  const fullViewUrl = `${basePath}/${repoName}?fv_${fk}=${encodeURIComponent(fv)}`;
  const expectedTypes = buildExpectedMap(schema, columns);
  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs text-base-content/60">
          <span class="font-mono">{repoName}</span>
          <span class="opacity-50"> where </span>
          <span class="font-mono">{fk}</span>
          <span class="opacity-50"> = </span>
          <span class="font-mono break-all">{fv}</span>
          <span class="opacity-50"> · </span>
          <span>
            {docs.length} doc{docs.length !== 1 ? "s" : ""}
          </span>
        </div>
        <a href={fullViewUrl} class="btn btn-sm btn-outline">
          Full view →
        </a>
      </div>
      <div class="overflow-x-auto rounded-box border border-base-300 bg-base-100">
        <table class="table table-xs w-full">
          <thead>
            <tr class="bg-base-200/50">
              {columns.map((c, i) => (
                <th
                  key={i}
                  class="text-xs font-semibold text-base-content/60 uppercase tracking-wide"
                >
                  {c}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 ? (
              <tr>
                <td
                  colspan={columns.length + 1}
                  class="text-center py-10 text-base-content/40"
                >
                  No related documents
                </td>
              </tr>
            ) : (
              docs.map((d, ri) => {
                const id = String(d["docId"] ?? d["id"] ?? "");
                const editUrl = `${basePath}/${repoName}/${encodeURIComponent(id)}/edit`;
                return (
                  <tr key={ri} class="hover">
                    {columns.map((c, ci) => {
                      const val = d[c];
                      const expected = expectedTypes[c];
                      const mismatch = expected
                        ? mismatchMessage(expected, val)
                        : null;
                      return (
                        <td key={ci} class="align-top py-1.5">
                          <CellValue val={val} mismatch={mismatch} />
                        </td>
                      );
                    })}
                    <td class="text-right py-1.5">
                      <a href={editUrl} class="btn btn-xs btn-ghost">
                        Edit
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {(pagination.hasPrev || pagination.hasNext) && (
        <div class="flex justify-center items-center gap-2">
          {pagination.hasPrev ? (
            <button
              type="button"
              class="btn btn-xs btn-outline"
              data-frs-panel-page="prev"
              data-cursor={pagination.prevCursor}
            >
              ← Previous
            </button>
          ) : (
            <button class="btn btn-xs btn-outline" disabled>
              ← Previous
            </button>
          )}
          {pagination.hasNext ? (
            <button
              type="button"
              class="btn btn-xs btn-outline"
              data-frs-panel-page="next"
              data-cursor={pagination.nextCursor}
            >
              Next →
            </button>
          ) : (
            <button class="btn btn-xs btn-outline" disabled>
              Next →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function buildExpectedMap(
  schema: import("zod").ZodObject<any> | undefined,
  columns: string[],
): Record<string, ExpectedType> {
  if (!schema) return {};
  const out: Record<string, ExpectedType> = {};
  for (const c of columns) {
    out[c] = expectedTypeOf(resolveAtPath(schema, c));
  }
  return out;
}
