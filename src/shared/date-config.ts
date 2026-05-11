import { Timestamp } from "firebase-admin/firestore";

export type DateHandlingMode = "preserve" | "normalize";

let currentMode: DateHandlingMode = "preserve";

export function setDateHandling(mode: DateHandlingMode): void {
  currentMode = mode;
}

export function getDateHandling(): DateHandlingMode {
  return currentMode;
}

function isTimestampLike(
  v: unknown,
): v is { _seconds: number; _nanoseconds: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { _seconds?: unknown })._seconds === "number" &&
    typeof (v as { _nanoseconds?: unknown })._nanoseconds === "number"
  );
}

export function coerceToDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value instanceof Timestamp) return value.toDate();
  if (isTimestampLike(value)) {
    return new Date(
      value._seconds * 1000 + Math.floor(value._nanoseconds / 1e6),
    );
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function normalizeTimestamps<T>(value: T): T {
  if (value instanceof Timestamp) return value.toDate() as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => normalizeTimestamps(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeTimestamps(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function maybeNormalize<T>(value: T): T {
  return currentMode === "normalize" ? normalizeTimestamps(value) : value;
}
