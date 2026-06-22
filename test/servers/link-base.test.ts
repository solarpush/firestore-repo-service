/**
 * Tests for the same-function URL prefix helper:
 * - under the emulator, an explicit `region` overrides the `us-central1`
 *   fallback (fixes login/session POSTs 404-ing in non-default regions),
 * - `resolveRegion` normalises the `HttpsOptions.region` shapes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getLinkBase,
  resolveRegion,
} from "../../src/servers/utils/link-base";

const ENV_KEYS = [
  "FUNCTIONS_EMULATOR",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "FUNCTION_REGION",
  "FUNCTION_TARGET",
] as const;

describe("getLinkBase (emulator)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["FUNCTIONS_EMULATOR"] = "true";
    process.env["GCLOUD_PROJECT"] = "my-proj";
    process.env["FUNCTION_TARGET"] = "admin";
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("falls back to us-central1 with no region hint", () => {
    expect(getLinkBase({}, "/")).toBe("/my-proj/us-central1/admin");
  });

  test("an explicit region overrides the fallback", () => {
    expect(getLinkBase({}, "/", "europe-west1")).toBe(
      "/my-proj/europe-west1/admin",
    );
  });

  test("explicit region wins over FUNCTION_REGION", () => {
    process.env["FUNCTION_REGION"] = "asia-east1";
    expect(getLinkBase({}, "/", "europe-west1")).toBe(
      "/my-proj/europe-west1/admin",
    );
  });

  test("FUNCTION_REGION is used when no explicit region is passed", () => {
    process.env["FUNCTION_REGION"] = "asia-east1";
    expect(getLinkBase({}, "/")).toBe("/my-proj/asia-east1/admin");
  });

  test("appends the static base path", () => {
    expect(getLinkBase({}, "/admin", "europe-west1")).toBe(
      "/my-proj/europe-west1/admin/admin",
    );
  });
});

describe("resolveRegion", () => {
  test("returns a plain string region", () => {
    expect(resolveRegion("europe-west1")).toBe("europe-west1");
  });
  test("takes the first element of an array", () => {
    expect(resolveRegion(["europe-west1", "us-central1"])).toBe("europe-west1");
  });
  test("returns undefined for non-string shapes (Expression/ResetValue)", () => {
    expect(resolveRegion(undefined)).toBeUndefined();
    expect(resolveRegion({ value: () => "x" })).toBeUndefined();
    expect(resolveRegion([{ cel: true }])).toBeUndefined();
  });
});
