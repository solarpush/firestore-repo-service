/**
 * Tests for the GCP Logs Explorer deep-link helper:
 * - `gcpLogsUrl` is opt-in (disabled / missing inputs → undefined),
 * - builds a project-scoped, field-filtered Logs Explorer URL when enabled,
 * - `resolveGcpProjectId` honours the explicit value then the env fallbacks,
 * - `BaseErrorHandler.gcpLogsUrl` proxies the option through to the helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseErrorHandler } from "../../src/servers/hono/error-handler";
import {
  gcpLogsUrl,
  resolveGcpProjectId,
} from "../../src/servers/hono/gcp-logs";

const ENV_KEYS = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GCP_PROJECT",
] as const;

describe("gcpLogsUrl", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("returns undefined when disabled", () => {
    expect(
      gcpLogsUrl("abc123", { enabled: false, projectId: "p" }),
    ).toBeUndefined();
    expect(gcpLogsUrl("abc123", { projectId: "p" })).toBeUndefined();
  });

  test("returns undefined when errorId is missing", () => {
    expect(
      gcpLogsUrl(undefined, { enabled: true, projectId: "p" }),
    ).toBeUndefined();
    expect(gcpLogsUrl("", { enabled: true, projectId: "p" })).toBeUndefined();
  });

  test("returns undefined when no project id can be resolved", () => {
    expect(gcpLogsUrl("abc123", { enabled: true })).toBeUndefined();
  });

  test("builds a project-scoped, field-filtered Logs Explorer URL", () => {
    const url = gcpLogsUrl("abc123", { enabled: true, projectId: "my-proj" });
    expect(url).toBe(
      "https://console.cloud.google.com/logs/query;query=" +
        encodeURIComponent('jsonPayload.errorId="abc123"') +
        "?project=my-proj",
    );
  });

  test("honours a custom field and a lookback duration", () => {
    const url = gcpLogsUrl("xyz", {
      enabled: true,
      projectId: "p",
      field: "traceId",
      duration: "PT1H",
    });
    expect(url).toContain(
      "query=" + encodeURIComponent('jsonPayload.traceId="xyz"'),
    );
    expect(url).toContain(";duration=PT1H");
    expect(url).toContain("?project=p");
  });

  test("falls back to the project id from the environment", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "env-proj";
    const url = gcpLogsUrl("abc", { enabled: true });
    expect(url).toContain("?project=env-proj");
  });
});

describe("resolveGcpProjectId", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("prefers the explicit value", () => {
    process.env["GCLOUD_PROJECT"] = "from-env";
    expect(resolveGcpProjectId("explicit")).toBe("explicit");
  });

  test("falls back through the env vars in order", () => {
    process.env["GCP_PROJECT"] = "third";
    expect(resolveGcpProjectId()).toBe("third");
    process.env["GCLOUD_PROJECT"] = "second";
    expect(resolveGcpProjectId()).toBe("second");
    process.env["GOOGLE_CLOUD_PROJECT"] = "first";
    expect(resolveGcpProjectId()).toBe("first");
  });

  test("returns undefined when nothing is set", () => {
    expect(resolveGcpProjectId()).toBeUndefined();
  });
});

describe("BaseErrorHandler.gcpLogsUrl", () => {
  class ExposedHandler extends BaseErrorHandler {
    url(errorId?: string) {
      return this.gcpLogsUrl(errorId);
    }
  }

  test("is disabled by default", () => {
    expect(new ExposedHandler().url("abc")).toBeUndefined();
  });

  test("proxies the constructor option to the helper", () => {
    const handler = new ExposedHandler({
      gcpLogs: { enabled: true, projectId: "p" },
    });
    expect(handler.url("abc")).toContain("?project=p");
    expect(handler.url(undefined)).toBeUndefined();
  });
});
