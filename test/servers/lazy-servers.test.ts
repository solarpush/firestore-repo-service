/**
 * Regression tests — `createServers().admin/crud()` and `createSyncTriggers()`
 * must build WITHOUT resolving Firestore (the `() => getFirestore()` factory is
 * never called at definition time), so server configs can live in separate
 * files imported by the Functions entrypoint before `initializeApp()`. The db
 * is only touched when a request handler actually uses a repository method.
 */

import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

plugin({
  name: "raw-js-as-text",
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
const { createSyncTriggers } = await import("../../src/sync/triggers");
const { makeLazyRepo } = await import("../../src/repositories/factory");

const schema = z.object({
  docId: z.string(),
  name: z.string(),
});

function buildMapping() {
  return {
    residences: createRepositoryConfig(schema)({
      path: "residences",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("residences").doc(docId),
      history: { enabled: true },
    }),
  };
}

/** Repository mapping whose db factory throws if ever resolved. */
function throwingMapping() {
  return createRepositoryMapping(() => {
    throw new Error("db factory must not be called at definition time");
  }, buildMapping());
}

describe("lazy servers — no Firestore resolution at definition time", () => {
  test("createServers().admin() does not resolve the db", () => {
    const servers = createServers(throwingMapping() as any);
    expect(() =>
      servers.admin({ basePath: "/", repos: { residences: {} } as any }),
    ).not.toThrow();
  });

  test("createServers().crud() does not resolve the db", () => {
    const servers = createServers(throwingMapping() as any);
    expect(() =>
      servers.crud({ basePath: "/", repos: { residences: {} } as any }),
    ).not.toThrow();
  });

  test("createServers().admin() still validates unknown repos lazily", () => {
    const servers = createServers(throwingMapping() as any);
    expect(() =>
      servers.admin({ repos: { ghost: {} } as any }),
    ).toThrow(/Unknown repo "ghost"/);
  });

  test("createSyncTriggers() registers triggers without resolving the db", () => {
    const repos = throwingMapping();
    const registered: { path: string }[] = [];
    const mkTrigger = (path: string, handler: any) => {
      registered.push({ path });
      return { path, handler };
    };

    const triggers = createSyncTriggers(repos as any, {
      deps: {
        firestoreTriggers: {
          onDocumentCreated: mkTrigger,
          onDocumentUpdated: mkTrigger,
          onDocumentDeleted: mkTrigger,
        },
        pubsub: { topic: () => ({ publishMessage: async () => {} }) },
      } as any,
    });

    // 3 triggers (create/update/delete) at the config-derived path.
    expect(registered.map((r) => r.path)).toEqual([
      "residences/{docId}",
      "residences/{docId}",
      "residences/{docId}",
    ]);
    expect(Object.keys(triggers).sort()).toEqual([
      "residences_onCreate",
      "residences_onDelete",
      "residences_onUpdate",
    ]);
  });
});

describe("makeLazyRepo", () => {
  const config = {
    path: "residences",
    isGroup: false,
    documentKey: "docId",
    schema,
    history: { enabled: true, subcollection: "audit" },
  };

  test("serves static metadata without resolving the repo", () => {
    let resolved = 0;
    const repo = makeLazyRepo(config, () => {
      resolved++;
      return { ref: { path: "residences" }, get: () => "x" } as any;
    });

    expect((repo as any).schema).toBe(schema);
    expect((repo as any)._systemKeys).toEqual(["docId"]);
    expect((repo as any)._isGroup).toBe(false);
    expect((repo as any)._historyConfig).toEqual(config.history);
    expect((repo as any)._historySubcollection).toBe("audit");
    expect(resolved).toBe(0); // static access never resolves
  });

  test("resolves the real repo on dynamic access, then memoizes", () => {
    let resolved = 0;
    const real = { ref: { path: "residences" }, get: () => "doc" };
    const repo = makeLazyRepo(config, () => {
      resolved++;
      return real as any;
    });

    expect((repo as any).ref).toBe(real.ref);
    expect((repo as any).get()).toBe("doc");
    expect(resolved).toBe(1); // resolved once, then reused
  });
});
