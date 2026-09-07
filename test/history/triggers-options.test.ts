import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

plugin({
  name: "raw-js-as-text-history-triggers-test",
  setup(build) {
    build.onLoad({ filter: /\.raw\.js$/ }, (args) => ({
      contents: `export default ${JSON.stringify(
        readFileSync(args.path, "utf8"),
      )};`,
      loader: "js",
    }));
  },
});

const { createRepositoryConfig, createRepositoryMapping, createServers } =
  await import("../../src/index");
const { createHistoryTriggers } = await import("../../src/history/triggers");

const userSchema = z.object({
  docId: z.string(),
  name: z.string(),
});

const postSchema = z.object({
  docId: z.string(),
  title: z.string(),
});

function buildMapping() {
  return {
    users: createRepositoryConfig(userSchema)({
      path: "users",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("users").doc(docId),
      history: {
        enabled: true,
      },
    }),
    posts: createRepositoryConfig(postSchema)({
      path: "posts",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("posts").doc(docId),
      history: {
        enabled: true,
        triggerOptions: {
          memory: "512MiB",
        },
      },
    }),
  };
}

describe("History triggerOptions support", () => {
  test("createHistoryTriggers passes path as string when no triggerOptions provided", () => {
    const repos = createRepositoryMapping(() => ({} as any), {
      users: createRepositoryConfig(userSchema)({
        path: "users",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("users").doc(docId),
        history: { enabled: true },
      }),
    });

    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createHistoryTriggers(repos, {
      deps: { onDocumentWritten: onDocumentWritten as any },
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.optsOrPath).toBe("users/{docId}");
  });

  test("createHistoryTriggers forwards global triggerOptions to onDocumentWritten", () => {
    const repos = createRepositoryMapping(() => ({} as any), {
      users: createRepositoryConfig(userSchema)({
        path: "users",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("users").doc(docId),
        history: { enabled: true },
      }),
    });

    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createHistoryTriggers(repos, {
      deps: { onDocumentWritten: onDocumentWritten as any },
      triggerOptions: {
        region: "europe-west1",
        vpcConnector: "my-vpc-connector",
        timeoutSeconds: 60,
      },
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "europe-west1",
      vpcConnector: "my-vpc-connector",
      timeoutSeconds: 60,
    });
  });

  test("createHistoryTriggers supports repository-level and override triggerOptions", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());

    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createHistoryTriggers(repos, {
      deps: { onDocumentWritten: onDocumentWritten as any },
      triggerOptions: {
        region: "europe-west1",
        memory: "256MiB",
      },
      repos: {
        posts: {
          triggerOptions: {
            timeoutSeconds: 120,
          },
        },
      },
    });

    expect(registered).toHaveLength(2);
    // users inherits global options
    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "europe-west1",
      memory: "256MiB",
    });
    // posts has global (region: "europe-west1"), repo config (memory: "512MiB"), and override (timeoutSeconds: 120)
    expect(registered[1]?.optsOrPath).toEqual({
      document: "posts/{docId}",
      region: "europe-west1",
      memory: "512MiB",
      timeoutSeconds: 120,
    });
  });

  test("servers.history() inherits deps.triggerOptions and allows local override", () => {
    const repos = createRepositoryMapping(() => ({} as any), {
      users: createRepositoryConfig(userSchema)({
        path: "users",
        isGroup: false,
        foreignKeys: ["docId"] as const,
        queryKeys: [] as const,
        documentKey: "docId",
        refCb: (db: any, docId: string) => db.collection("users").doc(docId),
        history: { enabled: true },
      }),
    });

    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    const servers = createServers(repos, {
      triggerOptions: {
        region: "europe-west1",
        vpcConnector: "shared-vpc",
      },
    });

    servers.history({
      deps: { onDocumentWritten: onDocumentWritten as any },
      triggerOptions: {
        memory: "1GiB",
      },
    });

    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "europe-west1",
      vpcConnector: "shared-vpc",
      memory: "1GiB",
    });
  });
});
