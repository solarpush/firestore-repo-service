import {
  BaseErrorHandler,
  BaseLogger,
  type ErrorHandlerContext,
  type LogSeverity,
} from "@lpdjs/firestore-repo-service/servers/hono";

/** Supported locales — the single source of truth (runtime + type). */
export const LOCALES = ["en", "fr"] as const;

/** A supported locale, derived from {@link LOCALES}. */
export type Locale = (typeof LOCALES)[number];

/** Localized message — one string per supported locale. */
export type LocalizedMessage = Record<Locale, string>;

/**
 * Minimal domain error — pure business semantics, zero HTTP awareness.
 * Thrown anywhere in useCases/handlers; the `AppErrorHandler` below maps it
 * to an HTTP response.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly userFacing: boolean;
  readonly errorId: string;
  readonly localizedMessage: LocalizedMessage;

  private constructor(
    localizedMessage: LocalizedMessage,
    statusCode: number,
    userFacing = false,
  ) {
    super(localizedMessage.en);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.userFacing = userFacing;
    this.localizedMessage = localizedMessage;
    this.errorId = Math.random().toString(36).slice(2, 12);
  }

  /** Business message shown directly to the user — HTTP 412. */
  static userMessage(message: LocalizedMessage): AppError {
    return new AppError(message, 412, true);
  }

  /** Resource not found — HTTP 404. */
  static notFound(resource?: string): AppError {
    return new AppError(
      {
        en: `${resource ?? "Resource"} not found`,
        fr: `${resource ?? "Ressource"} introuvable`,
      },
      404,
    );
  }

  /** Malformed request / invalid data — HTTP 400. */
  static badRequest(detail?: string): AppError {
    return new AppError(
      {
        en: `Bad request: ${detail ?? "invalid parameters"}`,
        fr: `Requête invalide : ${detail ?? "paramètres incorrects"}`,
      },
      400,
    );
  }

  /** Generic fallback message for non-user-facing errors. */
  static default(locale: Locale): string {
    return locale === "fr" ? "Une erreur est survenue" : "An error occurred";
  }
}

/**
 * Pick the response locale from the `Accept-Language` header.
 *
 * Parses the comma-separated, q-weighted list (e.g.
 * `fr-FR,fr;q=0.9,en;q=0.8`), keeps the supported locales, and returns the one
 * with the highest quality. Falls back to `"en"`.
 */
function pickLocale(c: {
  req: { header(name: string): string | undefined };
}): Locale {
  const header = c.req.header("accept-language");
  if (!header) return "en";

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=")[1] ?? "") : 1;
      return {
        lang: tag.trim().toLowerCase().split("-")[0] ?? "",
        quality: Number.isFinite(q) ? q : 1,
      };
    })
    .filter((x): x is { lang: Locale; quality: number } =>
      (LOCALES as readonly string[]).includes(x.lang),
    )
    .sort((a, b) => b.quality - a.quality);

  return ranked[0]?.lang ?? "en";
}

/**
 * Project logger — extends the package's {@link BaseLogger} and overrides the
 * single `write` hook to route to its sink (here `console`; swap for
 * `firebase-functions/v2` `logger` in real code). Exported as a singleton so
 * the same instance is passed per-API and reused inside useCases.
 */
export class AppLogger extends BaseLogger {
  protected override write(
    severity: LogSeverity,
    payload: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ severity, ...payload }));
  }
}

/** Shared logger instance (per-API `logger` + `this.logger` in useCases). */
export const appLogger = new AppLogger();

/**
 * Project error strategy — extends the package's {@link BaseErrorHandler}:
 * `mapError` handles our `AppError` (localized, user-facing aware), `logError`
 * routes through the injected `logger`, and unmatched errors fall back to the
 * built-in mapping via `super`. Passed **per API** in `apis.ts`.
 */
export class AppErrorHandler extends BaseErrorHandler {
  protected override mapError({
    error,
    c,
  }: ErrorHandlerContext): Response | null {
    if (!(error instanceof AppError)) return null; // → built-in mapping

    const locale = pickLocale(c);
    const logsUrl = this.gcpLogsUrl(error.errorId);
    return c.json(
      {
        // expose the localized message only when it is meant for the user
        error: error.userFacing
          ? error.localizedMessage[locale]
          : AppError.default(locale),
        errorId: error.errorId,
        // dev-only deep link to the matching GCP log (omitted when disabled)
        ...(logsUrl ? { logsUrl } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error.statusCode as any,
    );
  }

  protected override logError({ error, logger }: ErrorHandlerContext): void {
    // Use the injected logger, falling back to the shared singleton.
    const log = logger ?? appLogger;
    if (error instanceof AppError && error.statusCode < 500) log.warn(error.message);
    else log.error(error);
  }
}
