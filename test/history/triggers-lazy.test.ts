/**
 * Regression tests — `createHistoryTriggers` registers triggers **lazily**,
 * i.e. without resolving Firestore (the `() => getFirestore()` factory must not
 * run at trigger-definition time). The static trigger document path is derived
 * from the raw repository config (`path`), so `servers.history()` can run at
 * module load before `initializeApp()` — mirroring the lazy db init used by the
 * repository methods.
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

const { createRepositoryConfig, createRepositoryMapping } = await import(
  "../../src/index"
);
const { createHistoryTriggers } = await import("../../src/history/triggers");

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
    // history disabled → no trigger
    audits: createRepositoryConfig(schema)({
      path: "audits",
      isGroup: false,
      foreignKeys: ["docId"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("audits").doc(docId),
    }),
  };
}

/** Records every `onDocumentWritten(path, handler)` registration. */
function recordingDeps() {
  const registered: { path: string }[] = [];
  return {
    registered,
    deps: {
      onDocumentWritten: (path: string, handler: any) => {
        registered.push({ path });
        return { __trigger: true, path, handler };
      },
    },
  };
}

describe("createHistoryTriggers lazy db resolution", () => {
  test("does not call the db factory when registering triggers", () => {
    let calls = 0;
    const repos = createRepositoryMapping(() => {
      calls++;
      return { collection: () => ({}), collectionGroup: () => ({}), doc: () => ({}) } as any;
    }, buildMapping());

    const { deps } = recordingDeps();
    createHistoryTriggers(repos as any, { deps });

    // The whole point: registration must not resolve Firestore.
    expect(calls).toBe(0);
  });

  test("derives the trigger path from the raw config (history-enabled repo only)", () => {
    const repos = createRepositoryMapping(
      () => {
        throw new Error("db factory must not be called");
      },
      buildMapping(),
    );

    const { registered, deps } = recordingDeps();
    const triggers = createHistoryTriggers(repos as any, { deps });

    // Only the history-enabled repo gets a trigger, at `<path>/{docId}`.
    expect(registered).toEqual([{ path: "residences/{docId}" }]);
    expect(Object.keys(triggers)).toEqual(["residences_onHistory"]);
  });

  test("falls back to resolved repos when no raw mapping is exposed", () => {
    // A plain object of "resolved" repos (no `.rawMapping`) → introspect repo
    // fields directly. This forces the resolved-repo path.
    const plainRepos = {
      residences: {
        ref: { path: "residences" },
        _systemKeys: ["docId"],
        _isGroup: false,
        _historyConfig: { enabled: true },
      },
    };

    const { registered, deps } = recordingDeps();
    const triggers = createHistoryTriggers(plainRepos as any, { deps });

    expect(registered).toEqual([{ path: "residences/{docId}" }]);
    expect(Object.keys(triggers)).toEqual(["residences_onHistory"]);
  });
});
