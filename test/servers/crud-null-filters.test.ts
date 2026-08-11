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

    const pathObj = spec.paths["/api/partners/query"];
    expect(pathObj).toBeDefined();
    const queryOp = pathObj.post;
    expect(queryOp).toBeDefined();

    const requestBodySchema = spec.components.schemas["PartnerQueryRequestBody"] as any;
    expect(requestBodySchema).toBeDefined();

    // Check where clause prefixItems include "localPartner"
    const whereOneOf = requestBodySchema.properties.where.items.oneOf as any[];
    const allowedWhereFields = whereOneOf.map((tuple) => tuple.prefixItems[0].enum[0]);
    expect(allowedWhereFields).toContain("localPartner");
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
    const requestBodySchema = spec.components.schemas["PartnerQueryRequestBody"] as any;
    expect(requestBodySchema).toBeDefined();
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

