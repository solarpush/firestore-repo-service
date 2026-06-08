/**
 * Tests for the Hono server services DI container — lazy instantiation,
 * dependency resolution, cycle detection, and the AsyncLocalStorage-backed
 * request context.
 */

import { describe, test, expect } from "bun:test";
import type { Context } from "hono";
import {
  createServices,
  createRequestContextMiddleware,
  withRequestContext,
} from "../../src/servers/hono/services";

// Minimal Context stub — only `get` is exercised here.
function makeContext(values: Record<string, unknown> = {}): Context {
  return {
    get: (k: string) => values[k],
  } as unknown as Context;
}

describe("createServices", () => {
  test("instantiates services lazily and caches the singleton", () => {
    let dbCalls = 0;
    class Db {
      readonly id: number;
      constructor() {
        dbCalls++;
        this.id = dbCalls;
      }
    }
    const services = createServices({
      db: () => new Db(),
    });

    expect(dbCalls).toBe(0);
    const a = services.db;
    const b = services.db;
    expect(dbCalls).toBe(1);
    expect(a).toBe(b);
    expect(a.id).toBe(1);
  });

  test("resolves dependencies between services via the deps proxy", () => {
    class Db {
      readonly name = "db";
    }
    class Repo {
      constructor(readonly db: Db) {}
    }
    const services = createServices({
      db: () => new Db(),
      repo: ({ db }) => new Repo(db),
    });

    expect(services.repo.db).toBe(services.db);
    expect(services.repo.db.name).toBe("db");
  });

  test("exposes the built-in `ctx` service", () => {
    const services = createServices({
      noop: () => 1,
    });
    expect(services.ctx).toBeDefined();
    expect(services.ctx.maybeC).toBeUndefined();
  });

  test("`ctx.c` throws outside of a request scope", () => {
    const services = createServices({ noop: () => 1 });
    expect(() => services.ctx.c).toThrow(/outside of a request/);
  });

  test("throws on unknown service access", () => {
    const services = createServices({ a: () => 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (services as any).unknown).toThrow(/unknown service/);
  });

  test("detects circular dependencies with a clear path", () => {
    const services = createServices({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      a: ({ b }: any) => ({ b }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      b: ({ a }: any) => ({ a }),
    });
    expect(() => services.a).toThrow(/circular dependency/);
  });

  test("supports the class-form provider (auto `new Class(proxy)`)", () => {
    let ctorCalls = 0;
    class Repo {
      readonly id: number;
      constructor() {
        ctorCalls++;
        this.id = 42;
      }
    }
    type Svc = { repo: Repo; uc: UseCase };
    class UseCase {
      constructor(private readonly s: Svc) {}
      run() {
        return this.s.repo.id;
      }
    }
    const services = createServices({
      repo: Repo,
      uc: UseCase,
    });

    expect(ctorCalls).toBe(0);
    expect(services.uc.run()).toBe(42);
    expect(ctorCalls).toBe(1);
    // cached
    expect(services.uc).toBe(services.uc);
    expect(services.repo).toBe(services.repo);
  });

  test("class and factory forms can be mixed in the same map", () => {
    class Logger {
      log = (s: string) => `[log] ${s}`;
    }
    const services = createServices({
      logger: Logger,
      greet: ({ logger }) => (name: string) => logger.log(`hi ${name}`),
    });
    expect(services.greet("ada")).toBe("[log] hi ada");
  });
});

describe("withRequestContext + ctx service", () => {
  test("resolves ctx.c inside withRequestContext", async () => {
    const services = createServices({
      readUser: ({ ctx }) => () => ctx.c.get("user"),
    });

    const c = makeContext({ user: { id: "u1", role: "admin" } });
    const user = await withRequestContext({ c }, () => services.readUser());
    expect(user).toEqual({ id: "u1", role: "admin" });
  });

  test("isolates concurrent request contexts", async () => {
    const services = createServices({
      readUser: ({ ctx }) => () => ctx.c.get("user"),
    });

    const results = await Promise.all([
      withRequestContext({ c: makeContext({ user: "alice" }) }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return services.readUser();
      }),
      withRequestContext({ c: makeContext({ user: "bob" }) }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return services.readUser();
      }),
    ]);

    expect(results).toEqual(["alice", "bob"]);
  });
});

describe("createRequestContextMiddleware", () => {
  test("populates the store so downstream handlers see ctx.c", async () => {
    const services = createServices({ probe: ({ ctx }) => () => ctx.c });

    const mw = createRequestContextMiddleware();
    const c = makeContext({ user: "carol" });

    let seen: Context | undefined;
    await mw(c, async () => {
      seen = services.probe();
    });

    expect(seen).toBe(c);
    expect(services.ctx.maybeC).toBeUndefined(); // back outside scope
  });
});
