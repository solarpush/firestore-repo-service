import { describe, expect, test } from "bun:test";
import { generateOpenAPISpec } from "../../src/servers/crud/openapi";
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

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

  test("OpenAPI spec includes base object fields alongside nested fields for nullable ZodObject", () => {
    const registry = {
      partners: {
        name: "partners",
        repo: {} as any,
        systemKeys: [],
        schema: z.object({
          name: z.string(),
          localPartner: z.object({
            id: z.string(),
            companyName: z.string(),
          }).nullable(),
        }),
      },
    };

    const spec = generateOpenAPISpec(registry, "/api");

    const getParams = spec.paths["/api/partners"].get.parameters as any[];
    
    // Base object field query params
    const localPartnerParam = getParams.find((p) => p.name === "localPartner");
    expect(localPartnerParam).toBeDefined();

    const localPartnerEqParam = getParams.find((p) => p.name === "localPartner__eq");
    expect(localPartnerEqParam).toBeDefined();

    // Nested subfield query params
    const localPartnerIdParam = getParams.find((p) => p.name === "localPartner.id");
    expect(localPartnerIdParam).toBeDefined();

    const localPartnerCompanyNameParam = getParams.find((p) => p.name === "localPartner.companyName");
    expect(localPartnerCompanyNameParam).toBeDefined();

    // POST /query body schema (referenced via component schema PartnerQueryRequestBody)
    const requestBodySchema = spec.components.schemas["PartnerQueryRequestBody"] as any;
    const whereOneOf = requestBodySchema.properties.where.items.oneOf as any[];

    // Check where clause prefixItems include "localPartner", "localPartner.id", and "localPartner.companyName"
    const allowedWhereFields = whereOneOf.map((tuple) => tuple.prefixItems[0].enum[0]);
    expect(allowedWhereFields).toContain("localPartner");
    expect(allowedWhereFields).toContain("localPartner.id");
    expect(allowedWhereFields).toContain("localPartner.companyName");

    // Check select and orderBy enums
    const selectEnum = requestBodySchema.properties.select.items.enum;
    expect(selectEnum).toContain("localPartner");
    expect(selectEnum).toContain("localPartner.id");

    const orderByEnum = requestBodySchema.properties.orderBy.items.properties.field.enum;
    expect(orderByEnum).toContain("localPartner");
    expect(orderByEnum).toContain("localPartner.id");
  });

  test("resolveFieldPathSchema preserves nullable modifier on top-level object field", () => {
    const registry = {
      partners: {
        name: "partners",
        repo: {} as any,
        systemKeys: [],
        filterableFields: ["localPartner", "localPartner.id"],
        schema: z.object({
          localPartner: z.object({
            id: z.string(),
          }).nullable(),
        }),
      },
    };

    const spec = generateOpenAPISpec(registry, "/api");
    const getParams = spec.paths["/api/partners"].get.parameters as any[];
    const localPartnerParam = getParams.find((p) => p.name === "localPartner");
    expect(localPartnerParam).toBeDefined();
    // The JSON Schema for localPartner should allow null
    expect(JSON.stringify(localPartnerParam.schema)).toContain("null");
  });

  test("OpenAPI spec removes top-level 'type' when 'anyOf' or 'oneOf' is present to prevent generator conflicts (e.g. Orval)", () => {
    const customTimestampSchema = z
      .union([z.coerce.date(), z.string()])
      .transform((v) => new Date(v))
      .openapi({
        type: "string",
        format: "date-time",
        description: "Custom Timestamp",
      });

    const registry = {
      workshops: {
        name: "workshops",
        repo: {} as any,
        systemKeys: [],
        schema: z.object({
          startSessionDate: customTimestampSchema.optional().nullable(),
        }),
      },
    };

    const spec = generateOpenAPISpec(registry, "/api");
    const modelSchema = spec.components.schemas["Workshop"] as any;
    const startSessionDateProp = modelSchema.properties.startSessionDate;

    // Should have anyOf containing type: null
    expect(startSessionDateProp.anyOf).toBeDefined();
    // Must NOT have a top-level `type` property that overrides anyOf for generators like Orval
    expect(startSessionDateProp.type).toBeUndefined();

    // Verify in QueryRequestBody where clause tuple as well
    const queryBodySchema = spec.components.schemas["WorkshopQueryRequestBody"] as any;
    const whereItems = queryBodySchema.properties.where.items.oneOf as any[];
    const startSessionDateTuple = whereItems.find(
      (item) => item.prefixItems[0].enum[0] === "startSessionDate"
    );
    const valSchema = startSessionDateTuple.prefixItems[2];
    expect(valSchema.anyOf).toBeDefined();
    expect(valSchema.type).toBeUndefined();
  });
});

