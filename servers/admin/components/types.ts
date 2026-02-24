export interface PageOptions {
  title: string;
  breadcrumb?: { label: string; href?: string }[];
  flash?: { type: "success" | "error"; message: string };
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
