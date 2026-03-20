import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { ClientScript } from "./client-script";
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
      <body class="bg-base-200/50 min-h-screen flex flex-col">
        {/* Navbar */}
        <div class="navbar bg-neutral text-neutral-content shadow-sm sticky top-0 z-50 px-6">
          <div class="flex-1">
            <a
              href={basePath}
              class="font-bold text-lg tracking-tight hover:opacity-80 transition-opacity"
            >
              FRS Admin
            </a>
          </div>
        </div>

        <main class="px-6 py-8 w-full flex-1">
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
                    <li key={i} class="text-base-content/60">
                      {c.label}
                    </li>
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
              class={`alert ${flash.type === "success" ? "alert-success" : "alert-error"} mb-6`}
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
