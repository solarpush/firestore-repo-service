import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import {
  applyRules,
  computeDeepDiff,
  createBeforeRules,
  createRules,
  type DeepDiffReturn,
} from "../../src/servers/crud";
import { createCrudHandlers } from "../../src/servers/crud/handlers";

// Model
interface EventModel {
  docId: string;
  title: string;
  status: "draft" | "accepted" | "invoiced" | "canceled";
  fictiveDate: string | null;
  proId: string | null;
}

const eventSchema = z.object({
  docId: z.string(),
  title: z.string(),
  status: z.enum(["draft", "accepted", "invoiced", "canceled"]),
  fictiveDate: z.string().nullable().optional(),
  proId: z.string().nullable().optional(),
});

describe("CRUD Before Rules & Diff Engine", () => {
  test("computeDeepDiff correctly computes before, after and changes", () => {
    const before: EventModel = {
      docId: "e1",
      title: "Concert",
      status: "draft",
      fictiveDate: null,
      proId: null,
    };

    const diff = computeDeepDiff(before, {
      status: "canceled",
      title: "Concert", // unchanged
    });

    expect(diff.before.status).toBe("draft");
    expect(diff.after.status).toBe("canceled");
    expect(diff.changes.status).toBe("canceled");
    expect(diff.changes.title).toBeUndefined(); // ignored because valuesEqual
  });

  test("applyRules checks rules on modified fields and returns failed description", async () => {
    const eventsRules = createRules<EventModel>({
      status: [
        {
          description: "Interdit de modifier un event déjà facturé",
          rule: ({ diff }) => {
            return diff.before.status !== "invoiced";
          },
        },
        {
          description: "Status ne peut pas être 'canceled' sans rôle admin",
          rule: ({ diff, user }) => {
            if (diff.changes.status === "canceled") {
              return (user as any)?.role === "admin";
            }
            return true;
          },
        },
      ],
    });

    // Case 1: Invoiced event modification attempt
    const invoicedDiff: DeepDiffReturn<EventModel> = {
      before: { docId: "e1", title: "Show", status: "invoiced", fictiveDate: null, proId: null },
      after: { docId: "e1", title: "Show", status: "canceled", fictiveDate: null, proId: null },
      changes: { status: "canceled" },
    };

    const res1 = await applyRules(invoicedDiff, eventsRules, { uid: "u1", role: "admin" } as any);
    expect(res1.allowed).toBe(false);
    expect(res1.reason).toBe("Interdit de modifier un event déjà facturé");

    // Case 2: Non-admin trying to cancel
    const draftDiff: DeepDiffReturn<EventModel> = {
      before: { docId: "e2", title: "Show", status: "draft", fictiveDate: null, proId: null },
      after: { docId: "e2", title: "Show", status: "canceled", fictiveDate: null, proId: null },
      changes: { status: "canceled" },
    };

    const res2 = await applyRules(draftDiff, eventsRules, { uid: "u2", role: "user" } as any);
    expect(res2.allowed).toBe(false);
    expect(res2.reason).toBe("Status ne peut pas être 'canceled' sans rôle admin");

    // Case 3: Admin canceling
    const res3 = await applyRules(draftDiff, eventsRules, { uid: "u3", role: "admin" } as any);
    expect(res3.allowed).toBe(true);
    expect(res3.reason).toBeUndefined();
  });

  describe("CRUD routes integration with Before Rules & Batch", () => {
    const store: Record<string, any> = {
      e1: {
        docId: "e1",
        title: "Conference",
        status: "invoiced",
        fictiveDate: null,
        proId: null,
      },
      e2: {
        docId: "e2",
        title: "Workshop",
        status: "draft",
        fictiveDate: null,
        proId: null,
      },
    };

    const fakeRepo = {
      get: {
        byDocId: async (id: string) => store[id] ?? null,
      },
      query: {
        by: async ({ where }: any) => {
          const docId = where?.[0]?.[2];
          return store[docId] ? [store[docId]] : [];
        },
      },
      update: async (id: string, data: any) => {
        store[id] = { ...(store[id] || {}), ...data };
        return { data: () => ({ docId: id, ...store[id] }) };
      },
      batch: {
        create: () => {
          const ops: Array<() => Promise<void>> = [];
          return {
            update: (id: string, data: any) => {
              ops.push(async () => {
                store[id] = { ...(store[id] || {}), ...data };
              });
            },
            commit: async () => {
              for (const op of ops) await op();
            },
          };
        },
      },
    };

    const eventsCrudBefore = createRules<EventModel>({
      status: [
        {
          description: "Interdit de modifier un event déjà facturé",
          rule: ({ diff }) => {
            return diff.before.status !== "invoiced";
          },
        },
        {
          description: "Seul un admin peut annuler un event",
          rule: ({ diff, user }) => {
            if (diff.changes.status === "canceled") {
              return (user as any)?.role === "admin";
            }
            return true;
          },
        },
      ],
    });

    const registry: any = {
      events: {
        name: "events",
        path: "events",
        repo: fakeRepo,
        schema: eventSchema,
        systemKeys: ["docId"],
        documentKey: "docId",
        pageSize: 25,
        allowDelete: false,
        rules: {
          update: createBeforeRules(eventsCrudBefore),
        },
      },
    };

    const handlers = createCrudHandlers(registry, "", true);

    const app = new Hono();
    // Middleware to inject user from header
    app.use("*", async (c, next) => {
      const role = c.req.header("x-user-role");
      if (role) {
        c.set("user" as any, { uid: "u123", role });
      }
      await next();
    });

    app.patch("/events/:id", async (c) => {
      const body = await c.req.json();
      return handlers.handleUpdate({ c, input: body }, true);
    });

    app.post("/events/batch", async (c) => {
      const body = await c.req.json();
      return handlers.handleBatch({ c, input: body });
    });

    test("PATCH /events/e1 on invoiced event is rejected with 403 and rule description", async () => {
      const res = await app.request("/events/e1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "admin",
        },
        body: JSON.stringify({ status: "canceled" }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Interdit de modifier un event déjà facturé");
    });

    test("PATCH /events/e2 with non-admin canceling is rejected with 403 and role error", async () => {
      const res = await app.request("/events/e2", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "user",
        },
        body: JSON.stringify({ status: "canceled" }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Seul un admin peut annuler un event");
    });

    test("PATCH /events/e2 with admin canceling succeeds with 200", async () => {
      const res = await app.request("/events/e2", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "admin",
        },
        body: JSON.stringify({ status: "canceled" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(store["e2"].status).toBe("canceled");
    });

    test("POST /events/batch with violating update operation is rejected with 403 and rule description", async () => {
      const res = await app.request("/events/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "admin",
        },
        body: JSON.stringify({
          operations: [
            {
              type: "update",
              id: "e1", // invoiced event!
              data: { status: "canceled" },
            },
          ],
        }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Interdit de modifier un event déjà facturé");
    });
  });
});
