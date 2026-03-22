import { z } from "zod";
import {
  getTypeName,
  getInnerType,
  getShape,
} from "../shared/zod-compat";
import type { SqlColumn, SqlDialect, LogicalType } from "./types";

const WRAPPER_TYPES = new Set(["ZodOptional", "ZodNullable", "ZodDefault"]);

function unwrap(schema: z.ZodType): { inner: z.ZodType; nullable: boolean } {
  let current = schema;
  let nullable = false;

  for (;;) {
    const name = getTypeName(current);
    if (!WRAPPER_TYPES.has(name)) break;
    if (name === "ZodOptional" || name === "ZodNullable") nullable = true;
    const inner = getInnerType(current);
    if (!inner) break;
    current = inner;
  }

  return { inner: current, nullable };
}

const LOGICAL_MAP: Record<string, LogicalType> = {
  ZodString: "string",
  ZodNumber: "number",
  ZodBigInt: "bigint",
  ZodBoolean: "boolean",
  ZodDate: "timestamp",
  ZodEnum: "string",
  ZodNativeEnum: "string",
  ZodLiteral: "string",
};

export function zodTypeToLogical(schema: z.ZodType): LogicalType {
  const { inner } = unwrap(schema);
  return LOGICAL_MAP[getTypeName(inner)] ?? "json";
}

export interface ZodSchemaToColumnsOptions {
  primaryKey?: string;
  exclude?: string[];
  columnMap?: Record<string, string>;
}

/**
 * Recursively flatten a Zod object schema into flat SQL columns.
 * Nested objects produce `parent_child` column names.
 * Arrays and non-object complex types become JSON columns.
 */
function flattenSchema(
  shape: Record<string, z.ZodType>,
  dialect: SqlDialect,
  prefix: string,
  parentNullable: boolean,
  excludeSet: Set<string>,
  columnMap: Record<string, string>,
  primaryKey: string | undefined,
  columns: SqlColumn[],
): void {
  for (const [field, fieldSchema] of Object.entries(shape)) {
    const fullKey = prefix ? `${prefix}__${field}` : field;

    // Exclude check on the original (dotless) path and the flattened key
    if (excludeSet.has(field) || excludeSet.has(fullKey)) continue;

    const { inner, nullable } = unwrap(fieldSchema);
    const typeName = getTypeName(inner);
    const isNullable = parentNullable || nullable;

    // Nested object → recurse to flatten
    if (typeName === "ZodObject") {
      const nestedShape = getShape(inner as z.ZodObject<any>);
      flattenSchema(
        nestedShape,
        dialect,
        fullKey,
        isNullable,
        excludeSet,
        columnMap,
        primaryKey,
        columns,
      );
      continue;
    }

    // Arrays and other complex types → JSON
    const logical = LOGICAL_MAP[typeName] ?? "json";
    const isPK = fullKey === primaryKey || field === primaryKey;
    const colName = columnMap[fullKey] ?? columnMap[field] ?? fullKey;

    columns.push({
      name: colName,
      sqlType: dialect.mapType(logical),
      nullable: isPK ? false : isNullable,
      isPrimaryKey: isPK,
    });
  }
}

/**
 * Convert a Zod object schema into an array of {@link SqlColumn} definitions
 * suitable for SQL table creation.
 *
 * Nested ZodObject fields are recursively flattened into separate columns
 * with underscore-separated names (e.g. `address.street` → `address_street`).
 * Arrays become JSON columns.
 */
export function zodSchemaToColumns(
  schema: z.ZodObject<any>,
  dialect: SqlDialect,
  options: ZodSchemaToColumnsOptions = {},
): SqlColumn[] {
  const { primaryKey, exclude = [], columnMap = {} } = options;
  const excludeSet = new Set(exclude);
  const shape = getShape(schema);
  const columns: SqlColumn[] = [];

  flattenSchema(shape, dialect, "", false, excludeSet, columnMap, primaryKey, columns);

  return columns;
}
