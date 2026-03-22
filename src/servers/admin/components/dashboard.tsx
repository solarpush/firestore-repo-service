import { PageShell, renderHtml } from "./shell";

export function renderDashboardJsx(
  repos: { name: string; path: string }[],
  basePath: string,
): string {
  return renderHtml(
    <PageShell opts={{ title: "Repositories", basePath }}>
      {repos.length === 0 ? (
        <div class="text-center py-20 text-base-content/50">
          <p class="text-lg font-medium mb-1">No repositories configured</p>
          <p class="text-sm">
            Add a repository to your FRS config to get started.
          </p>
        </div>
      ) : (
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {repos.map((r) => (
            <a
              key={r.name}
              href={`${basePath}/${r.name}`}
              class="card bg-base-100 border border-base-300 hover:shadow-md no-underline transition-shadow"
            >
              <div class="card-body p-5">
                <h2 class="card-title text-sm font-semibold">{r.name}</h2>
                <p class="text-xs text-base-content/50 font-mono">{r.path}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </PageShell>,
  );
}
