import { PageShell, renderHtml } from "./shell";

export function renderDashboardJsx(
  repos: { name: string; path: string }[],
  basePath: string,
): string {
  return renderHtml(
    <PageShell opts={{ title: "Repositories", basePath }}>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {repos.length === 0 ? (
          <p class="text-base-content/50 col-span-full text-center py-12">
            No repositories configured.
          </p>
        ) : (
          repos.map((r) => (
            <a
              key={r.name}
              href={`${basePath}/${r.name}`}
              class="card bg-base-100 shadow hover:shadow-md transition-shadow border border-base-300 hover:border-primary no-underline"
            >
              <div class="card-body">
                <h2 class="card-title text-base">{r.name}</h2>
                <p class="text-sm text-base-content/50 font-mono">{r.path}</p>
                <div class="card-actions justify-end mt-2">
                  <span class="badge badge-primary badge-outline">
                    Browse →
                  </span>
                </div>
              </div>
            </a>
          ))
        )}
      </div>
    </PageShell>,
  );
}
