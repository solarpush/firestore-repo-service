/**
 * Regression tests for #10 — bulk operations surface partial failures via
 * onWriteError/onWriteResult instead of failing silently.
 */

import { describe, test, expect } from "bun:test";
import { createBulkMethods } from "../../src/methods/bulk";

/** A fake BulkWriter that drives the registered error/result callbacks. */
function makeFakeDb(failPaths: Set<string>, code = 7 /* PERMISSION_DENIED */) {
  const ops: Array<{ ref: any }> = [];
  let onErr: ((e: any) => boolean) | null = null;
  let onOk: ((ref: any) => void) | null = null;

  const writer = {
    onWriteError(cb: (e: any) => boolean) {
      onErr = cb;
    },
    onWriteResult(cb: (ref: any) => void) {
      onOk = cb;
    },
    set(ref: any) {
      ops.push({ ref });
    },
    update(ref: any) {
      ops.push({ ref });
    },
    delete(ref: any) {
      ops.push({ ref });
    },
    async close() {
      for (const { ref } of ops) {
        if (failPaths.has(ref.path)) {
          // Drive the retry protocol until the lib gives up.
          let failedAttempts = 0;
          let retry = true;
          while (retry) {
            retry = onErr
              ? onErr({ documentRef: ref, code, failedAttempts, message: "denied" })
              : false;
            failedAttempts++;
            if (failedAttempts > 50) break; // safety
          }
        } else {
          onOk?.(ref);
        }
      }
    },
  };
  const db = { bulkWriter: () => writer } as any;
  return db;
}

const ref = (path: string) => ({ path });

describe("#10 bulk partial-failure observability", () => {
  test("collects failures and reports successes via callbacks", async () => {
    const db = makeFakeDb(new Set(["users/u2"]));
    const bulk = createBulkMethods(db);
    const successes: string[] = [];
    const failures: string[] = [];

    const res = await bulk.set(
      [
        { docRef: ref("users/u1"), data: { a: 1 } },
        { docRef: ref("users/u2"), data: { a: 2 } },
        { docRef: ref("users/u3"), data: { a: 3 } },
      ],
      {
        onSuccess: (r: any) => successes.push(r.path),
        onError: ({ ref: r }) => failures.push(r.path),
      },
    );

    expect(successes.sort()).toEqual(["users/u1", "users/u3"]);
    expect(failures).toEqual(["users/u2"]);
    expect(res.failures.map((f) => f.ref.path)).toEqual(["users/u2"]);
  });

  test("throws when a failure occurs and no onError handler is provided", async () => {
    const db = makeFakeDb(new Set(["users/u1"]));
    const bulk = createBulkMethods(db);
    await expect(
      bulk.set([{ docRef: ref("users/u1"), data: { a: 1 } }]),
    ).rejects.toThrow(/bulk operation failed/);
  });

  test("retryable errors are retried up to maxAttempts", async () => {
    // code 14 = UNAVAILABLE (retryable); lib retries until failedAttempts >= maxAttempts.
    const db = makeFakeDb(new Set(["users/u1"]), 14);
    const bulk = createBulkMethods(db);
    const res = await bulk.set(
      [{ docRef: ref("users/u1"), data: { a: 1 } }],
      { maxAttempts: 3, onError: () => {} },
    );
    expect(res.failures).toHaveLength(1);
  });

  test("full success returns empty failures and does not throw", async () => {
    const db = makeFakeDb(new Set());
    const bulk = createBulkMethods(db);
    const res = await bulk.delete([ref("users/u1"), ref("users/u2")]);
    expect(res.failures).toEqual([]);
  });
});
