/**
 * Regression tests — `createRepositoryMapping` resolves Firestore lazily.
 *
 * The mapping must accept a `() => Firestore` factory and only invoke it on
 * first repository access (never at construction / import time), so consumers
 * can call `getFirestore()` before it would otherwise run at module import,
 * i.e. after `initializeApp()`.
 */

import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

// The barrel pulls in the admin server which imports a `.raw.js` asset as
// text (tsup does this via esbuild). Teach Bun the same loader before the
// dynamic import below so the barrel is resolvable under `bun test`.
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

const schema = z.object({
  docId: z.string(),
  email: z.string(),
});

/** Minimal Firestore stub — `createRepository` only touches collection refs. */
function makeFakeFirestore() {
  const ref = { id: "ref" };
  return {
    collection: () => ref,
    collectionGroup: () => ref,
    doc: () => ref,
  } as any;
}

function buildMapping() {
  return {
    users: createRepositoryConfig(schema)({
      path: "users",
      isGroup: false,
      foreignKeys: ["docId", "email"] as const,
      queryKeys: [] as const,
      documentKey: "docId",
      refCb: (db: any, docId: string) => db.collection("users").doc(docId),
    }),
  };
}

describe("createRepositoryMapping lazy db resolution", () => {
  test("does not call the db factory at construction time", () => {
    let calls = 0;
    createRepositoryMapping(() => {
      calls++;
      return makeFakeFirestore();
    }, buildMapping());

    expect(calls).toBe(0);
  });

  test("calls the db factory on first access only, then memoizes it", () => {
    let calls = 0;
    const repos = createRepositoryMapping(() => {
      calls++;
      return makeFakeFirestore();
    }, buildMapping());

    expect(calls).toBe(0);

    // First access resolves the factory exactly once.
    const usersRepo = repos.users;
    expect(usersRepo).toBeDefined();
    expect(calls).toBe(1);

    // Subsequent accesses reuse the memoized instance.
    void repos.users;
    void repos.users;
    expect(calls).toBe(1);
  });
});
