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
