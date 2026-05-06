function CellDate({ val }: { val: Date }) {
  return (
    <span class="text-sm text-base-content/80 font-mono tabular-nums whitespace-nowrap">
      {val.toLocaleString()}
    </span>
  );
}

/** Small warning icon with tooltip — rendered next to a cell when its value's runtime type doesn't match the schema. */
function TypeMismatchBadge({ message }: { message: string }) {
  return (
    <span
      class="tooltip tooltip-warning tooltip-right inline-flex align-middle ml-1 text-warning"
      data-tip={message}
      role="img"
      aria-label={message}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-3.5"
      >
        <path d="M12 2 1 22h22L12 2zm0 6 7.5 13h-15L12 8zm-1 4v4h2v-4h-2zm0 5v2h2v-2h-2z" />
      </svg>
    </span>
  );
}

export function CellValue({
  val,
  mismatch,
}: {
  val: unknown;
  mismatch?: string | null;
}) {
  const inner = renderInner(val);
  if (!mismatch) return inner;
  return (
    <span class="inline-flex items-start gap-0.5">
      {inner}
      <TypeMismatchBadge message={mismatch} />
    </span>
  );
}

function renderInner(val: unknown) {
  if (val === null || val === undefined) {
    return <span class="opacity-30 italic text-xs">—</span>;
  }

  if (typeof val === "boolean") {
    return val ? (
      <span class="badge badge-success badge-sm">true</span>
    ) : (
      <span class="badge badge-error badge-sm">false</span>
    );
  }

  if (val instanceof Date) {
    return <CellDate val={val} />;
  }

  // Firestore Timestamp (.toDate())
  if (
    typeof val === "object" &&
    val !== null &&
    typeof (val as any).toDate === "function"
  ) {
    return <CellDate val={(val as any).toDate() as Date} />;
  }

  if (typeof val === "number") {
    return <span class="text-sm font-mono tabular-nums">{String(val)}</span>;
  }

  if (Array.isArray(val)) {
    if (val.length === 0)
      return <span class="text-xs text-base-content/30">{"[]"}</span>;
    return (
      <ul class="list-none p-0 m-0 space-y-0.5 text-xs">
        {val.slice(0, 8).map((item, i) => (
          <li key={i} class="break-all">
            {typeof item === "object" ? JSON.stringify(item) : String(item)}
          </li>
        ))}
        {val.length > 8 && (
          <li class="text-base-content/40 italic">
            +{val.length - 8} more…
          </li>
        )}
      </ul>
    );
  }

  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0)
      return <span class="text-xs text-base-content/30">{"{}"}</span>;
    return (
      <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs m-0">
        {entries.slice(0, 8).map(([k, v]) => (
          <>
            <dt class="text-base-content/50 font-semibold whitespace-nowrap">
              {k}
            </dt>
            <dd class="break-all">{String(v ?? "")}</dd>
          </>
        ))}
        {entries.length > 8 && (
          <dt class="col-span-2 text-base-content/40 italic">
            +{entries.length - 8} more…
          </dt>
        )}
      </dl>
    );
  }

  const str = String(val);
  return <span class="text-sm break-all">{str}</span>;
}
