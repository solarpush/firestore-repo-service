import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

plugin({
  name: "raw-js-as-text-sync-triggers-test",
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
const { createFirestoreSync } = await import("../../src/sync/create-sync");
const { createSyncTriggers } = await import("../../src/sync/triggers");

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
    }),
    posts: createRepositoryConfig(postSchema)({
      path: "posts",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("posts").doc(docId),
    }),
  };
}

describe("Sync triggerOptions support", () => {
  test("createSyncTriggers passes path as string when no triggerOptions provided", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());
    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createSyncTriggers(repos, {
      deps: {
        firestoreTriggers: { onDocumentWritten: onDocumentWritten as any },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
    });

    expect(registered).toHaveLength(2);
    expect(registered[0]?.optsOrPath).toBe("users/{docId}");
    expect(registered[1]?.optsOrPath).toBe("posts/{docId}");
  });

  test("createSyncTriggers forwards global triggerOptions to onDocumentWritten", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());
    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createSyncTriggers(repos, {
      deps: {
        firestoreTriggers: { onDocumentWritten: onDocumentWritten as any },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
      triggerOptions: {
        region: "europe-west1",
        vpcConnector: "projects/p/locations/europe-west1/connectors/c",
        vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY",
        memory: "256MiB",
        timeoutSeconds: 60,
      },
    });

    expect(registered).toHaveLength(2);
    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "europe-west1",
      vpcConnector: "projects/p/locations/europe-west1/connectors/c",
      vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY",
      memory: "256MiB",
      timeoutSeconds: 60,
    });
    expect(registered[1]?.optsOrPath).toEqual({
      document: "posts/{docId}",
      region: "europe-west1",
      vpcConnector: "projects/p/locations/europe-west1/connectors/c",
      vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY",
      memory: "256MiB",
      timeoutSeconds: 60,
    });
  });

  test("createSyncTriggers allows per-repo triggerOptions to override global options", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());
    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    createSyncTriggers(repos, {
      deps: {
        firestoreTriggers: { onDocumentWritten: onDocumentWritten as any },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
      triggerOptions: {
        region: "europe-west1",
        memory: "256MiB",
      },
      repos: {
        users: {},
        posts: {
          triggerOptions: {
            memory: "512MiB",
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
    // posts overrides memory and adds timeoutSeconds
    expect(registered[1]?.optsOrPath).toEqual({
      document: "posts/{docId}",
      region: "europe-west1",
      memory: "512MiB",
      timeoutSeconds: 120,
    });
  });

  test("createFirestoreSync forwards triggerOptions to triggers", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());
    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    const sync = createFirestoreSync(repos, {
      deps: {
        firestoreTriggers: { onDocumentWritten: onDocumentWritten as any },
        pubsubHandler: { onMessagePublished: (() => {}) as any },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
      triggerOptions: {
        region: "us-central1",
        memory: "512MiB",
      },
    });

    expect(sync.functions).toHaveProperty("users_onSync");
    expect(sync.functions).toHaveProperty("posts_onSync");
    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "us-central1",
      memory: "512MiB",
    });
  });

  test("servers.sync() inherits deps.triggerOptions and allows local override", () => {
    const repos = createRepositoryMapping(() => ({} as any), buildMapping());
    const registered: Array<{ optsOrPath: any }> = [];
    const onDocumentWritten = (optsOrPath: any, handler: any) => {
      registered.push({ optsOrPath });
      return { optsOrPath, handler };
    };

    const servers = createServers(repos, {
      triggerOptions: {
        region: "europe-west1",
        vpcConnector: "common-connector",
      },
    });

    servers.sync({
      deps: {
        firestoreTriggers: { onDocumentWritten: onDocumentWritten as any },
        pubsubHandler: { onMessagePublished: (() => {}) as any },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) } as any,
      },
      triggerOptions: {
        memory: "1GiB",
      },
    });

    expect(registered[0]?.optsOrPath).toEqual({
      document: "users/{docId}",
      region: "europe-west1",
      vpcConnector: "common-connector",
      memory: "1GiB",
    });
  });
});
