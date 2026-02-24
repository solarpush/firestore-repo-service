import { PageShell, renderHtml } from "./shell";
import type { PageOptions } from "./types";

export function renderFormPageJsx(
  repoName: string,
  formHtml: string,
  mode: "create" | "edit",
  docId: string | null,
  basePath: string,
  flash?: PageOptions["flash"],
): string {
  const title =
    mode === "create"
      ? `Create ${repoName}`
      : `Edit ${repoName} / ${docId ?? ""}`;

  const crumbs =
    mode === "create"
      ? [
          { label: "Repositories", href: basePath },
          { label: repoName, href: `${basePath}/${repoName}` },
          { label: "New document" },
        ]
      : [
          { label: "Repositories", href: basePath },
          { label: repoName, href: `${basePath}/${repoName}` },
          { label: `Edit ${docId ?? ""}` },
        ];

  return renderHtml(
    <PageShell opts={{ title, breadcrumb: crumbs, basePath, flash }}>
      <div class="max-w-2xl">
        <div class="card bg-base-100 shadow border border-base-300">
          <div class="card-body">
            <div dangerouslySetInnerHTML={{ __html: formHtml }} />
          </div>
        </div>
      </div>
    </PageShell>,
  );
}
