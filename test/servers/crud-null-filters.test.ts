import { describe, expect, test } from "bun:test";
import { generateOpenAPISpec } from "../../src/servers/crud/openapi";
import { z } from "zod";

describe("CRUD server - null & __null__ filters & OpenAPI spec", () => {
  test("OpenAPI spec generates descriptions for null, __null__, in, nin, containsAny", () => {
    const registry = {
      partners: {
        name: "partners",
        repo: {} as any,
        systemKeys: [],
        schema: z.object({
          name: z.string(),
          localPartner: z.string().nullable(),
        }),
      },
    };

    const spec = generateOpenAPISpec(registry, "/api");

    const pathObj = spec.paths["/api/partners"];
    expect(pathObj).toBeDefined();
    const getOp = pathObj.get;
    expect(getOp).toBeDefined();

    const params = getOp.parameters as any[];
    expect(params).toBeDefined();

    // Check equality filter param description
    const localPartnerEqParam = params.find((p) => p.name === "localPartner__eq");
    expect(localPartnerEqParam).toBeDefined();
    expect(localPartnerEqParam.description).toContain("__null__");
    expect(localPartnerEqParam.description).toContain("null");

    // Check `in` filter param description
    const localPartnerInParam = params.find((p) => p.name === "localPartner__in");
    expect(localPartnerInParam).toBeDefined();
    expect(localPartnerInParam.description).toContain("__null__");
    expect(localPartnerInParam.description).toContain("comma-separated");

    // Check `containsAny` filter param description
    const localPartnerContainsAny = params.find((p) => p.name === "localPartner__containsAny");
    expect(localPartnerContainsAny).toBeDefined();
    expect(localPartnerContainsAny.description).toContain("containsAny");
    expect(localPartnerContainsAny.description).toContain("__null__");
  });
});
