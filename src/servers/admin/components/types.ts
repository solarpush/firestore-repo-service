export interface PageOptions {
  title: string;
  breadcrumb?: { label: string; href?: string }[];
  flash?: {
    type: "success" | "error" | "warning";
    message: string;
    /** Optional call-to-action button rendered next to the message */
    action?: { href: string; label: string; external?: boolean };
  };
  basePath?: string;
}

/** Firestore WHERE operator */
export type WhereOp =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any";

/** One active filter — serialized in URL as fv_{field} + fo_{field} */
export interface FilterState {
  field: string;
  op: WhereOp;
  value: string;
}

/** Per-column metadata used to render appropriate filter inputs/operators */
export interface ColumnMeta {
  name: string;
  /** Innermost Zod type name, e.g. "ZodString", "ZodNumber" */
  zodType: string;
  /** True if the field schema is wrapped in ZodOptional or ZodNullable */
  nullable?: boolean;
  /** For ZodEnum / ZodNativeEnum / ZodLiteral: the allowed values */
  enumValues?: readonly string[];
}

/** Active sort state for the list view */
export interface SortState {
  field: string;
  dir: "asc" | "desc";
}

/**
 * Metadata for one relational action column appended to the list table.
 * Each entry produces a dedicated button column (not a cell replacement).
 */
/** Query error state displayed at the top of the list page. */
export interface QueryError {
  /** "index" = missing composite index; "error" = generic query failure */
  type: "index" | "error";
  message: string;
  /** Firebase Console URL to create the missing index (always present for "index" type) */
  indexUrl?: string;
}

export interface RelationalFieldMeta {
  /** Field in this document whose value is used to build the link */
  key: string;
  /** Column header label, e.g. "Posts" or "Author" */
  column: string;
  /** Name of the target repository in the admin registry */
  targetRepo: string;
  /** Field name on the target repo used for the lookup */
  targetKey: string;
  /**
   * - "one"  → doc[key] = docId on the target → link to edit page
   * - "many" → doc[key] = filter value on the target → link to filtered list
   */
  type: "one" | "many";
}
