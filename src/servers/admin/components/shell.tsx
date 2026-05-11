import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { ClientScript } from "./client-script";
import { RightPanel } from "./right-panel";
import type { PageOptions } from "./types";

/** Render a JSX element to a complete HTML string (includes <!DOCTYPE html>) */
export function renderHtml(element: Child): string {
  return "<!DOCTYPE html>" + renderToString(element);
}

/** Available themes (DaisyUI 5). Order matters — first is the default. */
const THEMES = ["corporate", "silk", "dark"] as const;

const ThemeSwitcher: FC = () => (
  <div class="dropdown dropdown-end" data-frs-theme-switcher>
    <button
      type="button"
      tabIndex={0}
      class="btn btn-sm btn-ghost text-neutral-content gap-1.5"
      aria-label="Switch theme"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="size-4"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <span class="text-xs hidden sm:inline" data-frs-theme-current>
        Theme
      </span>
    </button>
    <ul
      tabIndex={0}
      class="dropdown-content menu menu-sm bg-base-100 text-base-content rounded-box z-50 mt-2 w-40 p-1 shadow-lg border border-base-300"
    >
      {THEMES.map((t) => (
        <li key={t}>
          <button
            type="button"
            data-frs-theme={t}
            class="capitalize justify-between"
          >
            <span>{t}</span>
            <span class="hidden text-primary" data-frs-theme-check={t}>
              ✓
            </span>
          </button>
        </li>
      ))}
    </ul>
  </div>
);

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
        {/* Early theme hydration — runs before paint to avoid flash of unstyled theme */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('frs-admin-theme');if(t){document.documentElement.setAttribute('data-theme',t);}}catch(_){}})();",
          }}
        />
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
          <div class="flex-none">
            <ThemeSwitcher />
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
              class={`alert ${
                flash.type === "success"
                  ? "alert-success"
                  : flash.type === "warning"
                    ? "alert-warning"
                    : "alert-error"
              } mb-6`}
            >
              <span class="flex-1">{flash.message}</span>
              {flash.action && (
                <a
                  href={flash.action.href}
                  {...(flash.action.external
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                  class="btn btn-sm btn-outline"
                >
                  {flash.action.label}
                </a>
              )}
            </div>
          )}

          {children}
        </main>

        <RightPanel basePath={basePath} />
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
