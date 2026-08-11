import { describe, expect, test } from "bun:test";
import { executePaginatedQuery } from "../../src/pagination";
import { buildAndCountQuery } from "../../src/query-builder";

/** Fake Query stub supporting count().get() and get() */
function makeFakeQuery(docs: any[] = []) {
  const query: any = {
    _docs: docs,
    _whereClauses: [] as any[],
    where: (field: string, op: string, val: any) => {
      const nextDocs = docs.filter((d) => {
        if (op === "==") return d[field] === val;
        if (op === "in") return Array.isArray(val) && val.includes(d[field]);
        return true;
      });
      const q = makeFakeQuery(nextDocs);
      q._whereClauses = [[field, op, val]];
      return q;
    },
    orderBy: () => query,
    limit: (n: number) => makeFakeQuery(docs.slice(0, n)),
    select: () => query,
    count: () => ({
      get: async () => ({
        data: () => ({ count: docs.length }),
      }),
    }),
    get: async () => ({
      docs: docs.map((data: any) => ({
        id: data.docId || data.id || "doc-1",
        data: () => data,
      })),
      size: docs.length,
      empty: docs.length === 0,
    }),
  };
  return query;
}

describe("buildAndCountQuery and executePaginatedQuery withTotal", () => {
  const sampleDocs = [
    { docId: "1", status: "active", role: "admin" },
    { docId: "2", status: "active", role: "user" },
    { docId: "3", status: "pending", role: "user" },
    { docId: "4", status: "inactive", role: "user" },
  ];

  test("pure AND query returns exact totalCount", async () => {
    const q = makeFakeQuery(sampleDocs);
    const result = await buildAndCountQuery(q, {
      where: [["status", "==", "active"]],
    });

    expect(result.count).toBe(2);
    expect(result.isExact).toBe(true);
  });

  test("orWhere query returns estimated totalCount with isExact=false", async () => {
    const q = makeFakeQuery(sampleDocs);
    const result = await buildAndCountQuery(q, {
      orWhere: [
        ["status", "==", "active"],
        ["role", "==", "admin"],
      ],
    });

    expect(result.count).toBe(3); // 2 active + 1 admin (docId 1 counted in both branches)
    expect(result.isExact).toBe(false);
  });

  test("executePaginatedQuery with withTotal=true returns totalCount and totalCountIsExact", async () => {
    const q = makeFakeQuery(sampleDocs);
    const paginated = await executePaginatedQuery(q, {
      pageSize: 2,
      where: [["status", "==", "active"]],
      withTotal: true,
    });

    expect(paginated.data.length).toBe(2);
    expect(paginated.totalCount).toBe(2);
    expect(paginated.totalCountIsExact).toBe(true);
  });
});

describe("createQueryMethods with include and sourceKey", () => {
  const { createQueryMethods } = require("../../src/methods/query");

  test("populateDocuments uses sourceKey when populating one-to-many relation", async () => {
    const residencesQuery = makeFakeQuery([
      { docId: "residence-123", name: "Grand Residence" },
    ]);

    const eventsDocs = [
      { docId: "event-1", residenceId: "residence-123", name: "Party" },
      { docId: "event-2", residenceId: "residence-123", name: "Meeting" },
    ];

    const eventsRepo = {
      query: {
        byResidenceId: async (val: string, opts?: any) => {
          return eventsDocs
            .filter((e) => e.residenceId === val)
            .map((e) => {
              if (opts?.select) {
                const sel: any = {};
                for (const k of opts.select) sel[k] = (e as any)[k];
                return sel;
              }
              return e;
            });
        },
      },
    };

    const relationalKeys = {
      events: {
        repo: "events",
        key: "residenceId",
        type: "many",
        sourceKey: "docId",
      },
    };

    const allRepositories = {
      events: eventsRepo,
    };

    const queryMethods = createQueryMethods(
      residencesQuery,
      ["docId"],
      relationalKeys as any,
      allRepositories,
    );

    const result: any = await queryMethods.paginate({
      pageSize: 10,
      include: [{ relation: "events", select: ["docId", "name"] }],
    });

    expect(result.data.length).toBe(1);
    expect(result.data[0].populated).toBeDefined();
    expect(result.data[0].populated.events).toHaveLength(2);
    expect(result.data[0].populated.events[0]).toEqual({
      docId: "event-1",
      name: "Party",
    });
  });
});

