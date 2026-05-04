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

const NULL_SENTINEL = "__null__";

/** Inline JS toggle that flips the sibling input value to "__null__" / "". */
function nullToggleScript(inputId: string): string {
  return `(function(cb){var i=document.getElementById('${inputId}');if(!i)return;if(cb.checked){i.dataset._prev=i.value;i.value='${NULL_SENTINEL}';i.disabled=true;i.style.opacity='0.35';}else{i.disabled=false;i.style.opacity='';i.value=(i.dataset._prev&&i.dataset._prev!=='${NULL_SENTINEL}')?i.dataset._prev:'';}})(this)`;
}

/** Inline JS that syncs a list of enum checkboxes into a CSV hidden input. */
function enumChecklistScript(hiddenId: string, group: string): string {
  return `(function(){var h=document.getElementById('${hiddenId}');var boxes=document.querySelectorAll('input[data-enum-group="${group}"]');h.value=Array.from(boxes).filter(function(b){return b.checked;}).map(function(b){return b.value;}).join(',');})()`;
}

function NullToggle({
  inputId,
  active,
}: {
  inputId: string;
  active: boolean;
}) {
  return (
    <label
      class="flex items-center gap-1 cursor-pointer select-none text-xs text-base-content/40 hover:text-base-content/70 border border-base-300 rounded px-2 shrink-0"
      title="Filter where field IS NULL"
    >
      <input
        type="checkbox"
        class="checkbox checkbox-xs"
        checked={active}
        onchange={nullToggleScript(inputId)}
      />
      <span>null</span>
    </label>
  );
}

function FilterValueInput({
  col,
  active,
}: {
  col: ColumnMeta;
  active?: FilterState;
}) {
  const val = active?.value ?? "";
  const isNull = val === NULL_SENTINEL;
  const inputId = `fv_input_${col.name.replace(/\./g, "__")}`;
  const op = active?.op;
  const isMultiOp = op === "in" || op === "not-in";

  // ── Enum / Literal columns ────────────────────────────────────────────────
  if (col.enumValues && col.enumValues.length > 0) {
    if (isMultiOp) {
      // Multi-select via checkbox group + hidden CSV input
      const selected = new Set(
        val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const group = `eg_${col.name.replace(/\./g, "__")}`;
      return (
        <div class="flex flex-wrap items-center gap-1 w-full">
          <input
            type="hidden"
            id={inputId}
            name={`fv_${col.name}`}
            value={val}
          />
          {col.enumValues.map((v) => (
            <label
              key={v}
              class="flex items-center gap-1 text-xs border border-base-300 rounded px-2 cursor-pointer hover:bg-base-200"
            >
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                value={v}
                checked={selected.has(v)}
                data-enum-group={group}
                onchange={enumChecklistScript(inputId, group)}
              />
              <span>{v}</span>
            </label>
          ))}
        </div>
      );
    }
    // Single-select for ==, !=, etc.
    return (
      <div class="flex items-center gap-1 w-full">
        <select
          id={inputId}
          name={`fv_${col.name}`}
          class="select select-sm select-bordered w-full"
          disabled={isNull}
          style={isNull ? "opacity:0.35" : undefined}
        >
          <option value="" selected={val === ""}>
            —
          </option>
          {col.enumValues.map((v) => (
            <option key={v} value={v} selected={val === v}>
              {v}
            </option>
          ))}
        </select>
        {col.nullable && <NullToggle inputId={inputId} active={isNull} />}
      </div>
    );
  }

  // ── Boolean ────────────────────────────────────────────────────────────────
  if (col.zodType === "ZodBoolean") {
    return (
      <div class="flex items-center gap-1 w-full">
        <select
          id={inputId}
          name={`fv_${col.name}`}
          class="select select-sm select-bordered w-full"
          disabled={isNull}
          style={isNull ? "opacity:0.35" : undefined}
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
        {col.nullable && <NullToggle inputId={inputId} active={isNull} />}
      </div>
    );
  }

  // ── Array (no nullable toggle: array-contains semantics differ) ───────────
  if (col.zodType === "ZodArray") {
    const isAny = active?.op === "array-contains-any";
    return (
      <input
        id={inputId}
        type="text"
        name={`fv_${col.name}`}
        value={val}
        placeholder={isAny ? "val1, val2, …" : "value"}
        class="input input-sm input-bordered w-full"
      />
    );
  }

  // ── Numeric ────────────────────────────────────────────────────────────────
  if (col.zodType === "ZodNumber" || col.zodType === "ZodBigInt") {
    return (
      <div class="flex items-center gap-1 w-full">
        <input
          id={inputId}
          type="number"
          name={`fv_${col.name}`}
          value={isNull ? "" : val}
          placeholder="value"
          class="input input-sm input-bordered w-full"
          disabled={isNull}
          style={isNull ? "opacity:0.35" : undefined}
        />
        {col.nullable && <NullToggle inputId={inputId} active={isNull} />}
      </div>
    );
  }

  // ── Date ───────────────────────────────────────────────────────────────────
  if (col.zodType === "ZodDate") {
    return (
      <div class="flex items-center gap-1 w-full">
        <input
          id={inputId}
          type="datetime-local"
          name={`fv_${col.name}`}
          value={isNull ? "" : val}
          class="input input-sm input-bordered w-full"
          disabled={isNull}
          style={isNull ? "opacity:0.35" : undefined}
        />
        {col.nullable && <NullToggle inputId={inputId} active={isNull} />}
      </div>
    );
  }

  // ── Default text ───────────────────────────────────────────────────────────
  return (
    <div class="flex items-center gap-1 w-full">
      <input
        id={inputId}
        type="text"
        name={`fv_${col.name}`}
        value={isNull ? "" : val}
        placeholder="value"
        class="input input-sm input-bordered w-full"
        disabled={isNull}
        style={isNull ? "opacity:0.35" : undefined}
      />
      {col.nullable && <NullToggle inputId={inputId} active={isNull} />}
    </div>
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
