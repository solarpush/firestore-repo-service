function CellDate({ val }: { val: Date }) {
  return <span class="text-sm">{val.toLocaleString()}</span>;
}

export function CellValue({ val }: { val: unknown }) {
  if (val === null || val === undefined) {
    return <span class="opacity-30">—</span>;
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

  if (Array.isArray(val)) {
    if (val.length === 0) return <span class="opacity-30 text-xs">{"[]"}</span>;
    return (
      <ul class="list-none p-0 m-0 space-y-0.5 text-xs">
        {val.slice(0, 5).map((item, i) => (
          <li key={i} class="flex items-start gap-1">
            <span class="text-base-content/40">·</span>
            <span>
              {typeof item === "object" ? JSON.stringify(item) : String(item)}
            </span>
          </li>
        ))}
        {val.length > 5 && (
          <li class="text-base-content/40">+{val.length - 5} more…</li>
        )}
      </ul>
    );
  }

  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0)
      return <span class="opacity-30 text-xs">{"{}"}</span>;
    return (
      <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs m-0">
        {entries.slice(0, 5).map(([k, v]) => (
          <>
            <dt class="text-base-content/50 font-medium whitespace-nowrap">
              {k}
            </dt>
            <dd class="truncate max-w-[120px]" title={String(v)}>
              {String(v ?? "")}
            </dd>
          </>
        ))}
        {entries.length > 5 && (
          <dt class="col-span-2 text-base-content/40">
            +{entries.length - 5} more…
          </dt>
        )}
      </dl>
    );
  }

  const str = String(val);
  if (str.length > 60) {
    return (
      <span class="truncate max-w-[180px] block text-sm" title={str}>
        {str.slice(0, 57)}…
      </span>
    );
  }
  return <span class="text-sm">{str}</span>;
}
