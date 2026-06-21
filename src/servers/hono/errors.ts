/**
 * Built-in error types thrown by the server pipeline and their default
 * HTTP mapping — shared by the request handler and {@link BaseErrorHandler}.
 */

import type { ZodError } from "zod";
import { ValidationError } from "./types";

/** Thrown when the request body cannot be read / parsed → HTTP 400. */
export class BadRequestError extends Error {
  readonly statusCode = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** Thrown when a handler's return value fails the `output` schema → HTTP 500. */
export class OutputValidationError extends Error {
  readonly statusCode = 500 as const;
  constructor(readonly zodError: ZodError) {
    super("Output validation failed");
    this.name = "OutputValidationError";
  }
}

/** Flatten a `ZodError` into a compact `{ path, code, message }[]`. */
export function formatZodIssues(error: ZodError): unknown {
  return error.issues.map((i) => ({
    path: i.path.join("."),
    code: i.code,
    message: i.message,
  }));
}

/**
 * Default JSON mapping for the package's own errors (`ValidationError`,
 * `BadRequestError`, `OutputValidationError`). Returns `null` for anything
 * else so the caller can decide (rethrow / custom handler).
 */
export function defaultErrorResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  err: unknown,
): Response | null {
  if (err instanceof ValidationError) {
    return c.json(
      {
        success: false,
        error: "Validation failed",
        issues: formatZodIssues(err.zodError),
      },
      400,
    );
  }
  if (err instanceof BadRequestError) {
    return c.json(
      { success: false, error: "Bad Request", message: err.message },
      400,
    );
  }
  if (err instanceof OutputValidationError) {
    return c.json(
      {
        success: false,
        error: "Output validation failed",
        issues: formatZodIssues(err.zodError),
      },
      500,
    );
  }
  return null;
}
