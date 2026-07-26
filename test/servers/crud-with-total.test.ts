import { describe, expect, test } from "bun:test";
import { executePaginatedQuery } from "../../src/pagination";
import { parseFilters } from "../../src/servers/crud/handlers";

describe("CRUD server - withTotal and meta parameters in GET list", () => {
  test("parseFilters skips withTotal, direction, and includes meta params", () => {
    // If parseFilters doesn't skip withTotal, it would generate a filter for "withTotal" == "true"
    const query = {
      pageSize: "10",
      withTotal: "true",
      direction: "next",
      includes: "author",
      status: "active",
    };

    // Exported or internal parseFilters call simulation
    // We can verify by calling parseFilters with null filterableFields (all fields allowed)
    const filters = parseFilters(query, undefined);

    // Only status should be in filters, not withTotal, direction, includes, or pageSize
    expect(filters).toEqual([
      { field: "status", op: "==", value: "active" },
    ]);
  });
});
