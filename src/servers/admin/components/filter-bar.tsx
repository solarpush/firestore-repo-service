import type { ColumnMeta, FilterState, WhereOp } from "./types";

// ---------------------------------------------------------------------------
// Operator definitions per Zod type
// ---------------------------------------------------------------------------

type OpDef = { value: WhereOp; label: string };

const OPS_TEXT: OpDef[] = [
  { value: "==", label: "=" },
  { value: "!=", label: "≠" },
  { value: "in", label: "in" },
  { value: "not-in", label: "not in" },
];
const OPS_NUMERIC: OpDef[] = [
  { value: "==", label: "=" },
  { value: "!=", label: "≠" },
  { value: "<", label: "<" },
  { value: "<=", label: "≤" },
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "in", label: "in" },
  { value: "not-in", label: "not in" },
];
const OPS_ARRAY: OpDef[] = [
  { value: "array-contains", label: "contains" },
  { value: "array-contains-any", label: "contains any" },
];

function opsForType(zodType: string): OpDef[] {
  switch (zodType) {
    case "ZodNumber":
    case "ZodBigInt":
    case "ZodDate":
      return OPS_NUMERIC;
    case "ZodBoolean":
      return OPS_TEXT;
    case "ZodArray":
      return OPS_ARRAY;
    default:
      return OPS_TEXT;
  }
}

// ---------------------------------------------------------------------------
// Value input per type
// ---------------------------------------------------------------------------

function FilterValueInput({
  col,
  active,
}: {
  col: ColumnMeta;
  active?: FilterState;
}) {
  const val = active?.value ?? "";

  if (col.zodType === "ZodBoolean") {
    return (
      <select
        name={`fv_${col.name}`}
        class="select select-sm select-bordered w-full"
      >
        <option value="" selected={val === ""}>
          —
        </option>
        <option value="true" selected={val === "true"}>
          true
        </option>
        <option value="false" selected={val === "false"}>
          false
        </option>
      </select>
    );
  }
  if (col.zodType === "ZodArray") {
    const isAny = active?.op === "array-contains-any";
    return (
      <input
        type="text"
        name={`fv_${col.name}`}
        value={val}
        placeholder={isAny ? "val1, val2, …" : "value"}
        class="input input-sm input-bordered w-full"
      />
    );
  }
  if (col.zodType === "ZodNumber" || col.zodType === "ZodBigInt") {
    return (
      <input
        type="number"
        name={`fv_${col.name}`}
        value={val}
        placeholder="value"
        class="input input-sm input-bordered w-full"
      />
    );
  }
  if (col.zodType === "ZodDate") {
    return (
      <input
        type="datetime-local"
        name={`fv_${col.name}`}
        value={val}
        class="input input-sm input-bordered w-full"
      />
    );
  }
  return (
    <input
      type="text"
      name={`fv_${col.name}`}
      value={val}
      placeholder="value"
      class="input input-sm input-bordered w-full"
    />
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export function FilterBar({
  action,
  columnMeta,
  activeFilters,
  isGroup,
}: {
  /** Form action URL (list page URL, without query params) */
  action: string;
  columnMeta: ColumnMeta[];
  activeFilters: FilterState[];
  /** Whether this repo is a collection group (subcollection) */
  isGroup?: boolean;
}) {
  const activeMap = Object.fromEntries(activeFilters.map((f) => [f.field, f]));
  const hasActive = activeFilters.length > 0;
  const needsIndexHint = activeFilters.length >= 2 || (isGroup && hasActive);

  // Columns that can be filtered (exclude pure-object columns)
  const filterable = columnMeta.filter(
    (c) => c.zodType !== "ZodObject" && c.zodType !== "ZodRecord",
  );

  return (
    <details
      class="collapse collapse-arrow bg-base-100 border border-base-300 rounded-box mb-6 shadow-sm"
      open={hasActive ? true : undefined}
    >
      <summary class="collapse-title text-sm font-medium py-2 min-h-0">
        Filters
        {hasActive && (
          <span class="badge badge-primary badge-sm ml-2">
            {activeFilters.length} active
          </span>
        )}
      </summary>
      <div class="collapse-content pb-4 pt-2">
        <form method="get" action={action}>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filterable.map((col) => {
              const ops = opsForType(col.zodType);
              const active = activeMap[col.name];
              const currentOp: WhereOp = active?.op ?? ops[0]!.value;
              return (
                <div key={col.name} class="flex flex-col gap-1.5">
                  <label class="text-xs font-semibold text-base-content/60 uppercase tracking-wide">
                    {col.name}
                  </label>
                  <div class="flex gap-1.5">
                    {ops.length > 1 ? (
                      <select
                        name={`fo_${col.name}`}
                        class="select select-sm select-bordered w-20 shrink-0"
                      >
                        {ops.map((o) => (
                          <option
                            key={o.value}
                            value={o.value}
                            selected={o.value === currentOp}
                          >
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      // Single op → hidden input, no select to clutter UI
                      <input
                        type="hidden"
                        name={`fo_${col.name}`}
                        value={ops[0]!.value}
                      />
                    )}
                    <FilterValueInput col={col} active={active} />
                  </div>
                </div>
              );
            })}
          </div>

          <div class="flex flex-wrap gap-2 mt-4 pt-3 border-t border-base-200 items-center">
            <button type="submit" class="btn btn-sm btn-primary">
              Apply
            </button>
            {hasActive && (
              <a href={action} class="btn btn-sm btn-ghost">
                Clear
              </a>
            )}
            {needsIndexHint && (
              <span class="text-xs text-warning ml-auto flex items-center gap-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {isGroup
                  ? "Collection group queries require a composite index"
                  : "Multiple filters may require a composite index"}
              </span>
            )}
          </div>
        </form>
      </div>
    </details>
  );
}
