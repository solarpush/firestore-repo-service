import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { ClientScript } from "./client-script.jsx";
import type { PageOptions } from "./types";

/** Render a JSX element to a complete HTML string (includes <!DOCTYPE html>) */
export function renderHtml(element: Child): string {
  return "<!DOCTYPE html>" + renderToString(element);
}

export const PageShell: FC<PropsWithChildren<{ opts: PageOptions }>> = ({
  opts,
  children,
}) => {
  const { title, breadcrumb, flash, basePath = "/" } = opts;

  return (
    <html lang="en" data-theme="corporate">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — FRS Admin</title>
        <link
          href="https://cdn.jsdelivr.net/npm/daisyui@5/themes.css"
          rel="stylesheet"
          type="text/css"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/daisyui@5/daisyui.css"
          rel="stylesheet"
          type="text/css"
        />
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
      </head>
      <body class="bg-base-200 min-h-screen">
        {/* Navbar */}
        <div class="navbar bg-primary text-primary-content shadow-sm sticky top-0 z-50">
          <div class="flex-1">
            <a href={basePath} class="btn btn-ghost text-lg font-bold">
              🔥 FRS Admin
            </a>
          </div>
          <div class="flex-none">
            <span class="badge badge-outline badge-lg text-primary-content/70 border-primary-content/40">
              firestore-repo-service
            </span>
          </div>
        </div>

        <main class="max-w-7xl mx-auto px-4 py-8">
          {/* Breadcrumbs */}
          {breadcrumb && breadcrumb.length > 0 && (
            <div class="text-sm breadcrumbs mb-4">
              <ul>
                {breadcrumb.map((c, i) =>
                  c.href ? (
                    <li key={i}>
                      <a href={c.href}>{c.label}</a>
                    </li>
                  ) : (
                    <li key={i}>{c.label}</li>
                  ),
                )}
              </ul>
            </div>
          )}

          <h1 class="text-2xl font-bold mb-6">{title}</h1>

          {/* Flash message */}
          {flash && (
            <div
              role="alert"
              class={`alert ${flash.type === "success" ? "alert-success" : "alert-error"} mb-4`}
            >
              <span>{flash.message}</span>
            </div>
          )}

          {children}
        </main>

        <ClientScript />
      </body>
    </html>
  );
};

/** Wrap a raw HTML string in the page shell (backward compat). */
export function renderPageJsx(content: string, opts: PageOptions): string {
  return renderHtml(
    <PageShell opts={opts}>
      <div dangerouslySetInnerHTML={{ __html: content }} />
    </PageShell>,
  );
}
