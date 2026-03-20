/**
 * Zod-to-HTML form generator.
 * Inspects a Zod schema's `_def` to produce typed HTML `<input>` / `<select>`
 * elements — no extra dependencies needed.
 *
 * Supported Zod types:
 *   ZodString, ZodNumber, ZodBoolean, ZodDate, ZodEnum,
 *   ZodOptional, ZodNullable, ZodDefault, ZodObject, ZodArray, ZodLiteral
 *
 * For ZodObject fields, nested sections are rendered with indentation.
 * For ZodArray and unknown types, a `<textarea>` with JSON hint is used.
 *
 * @example
 * ```typescript
 * import { zodToFields, renderForm } from "@lpdjs/firestore-repo-service/servers/admin";
 *
 * // Convert Zod schema to field descriptors
 * const schema = z.object({
 *   name: z.string(),
 *   email: z.string().email(),
 *   age: z.number().optional(),
 *   role: z.enum(["admin", "user"]),
 *   isActive: z.boolean().default(true),
 *   address: z.object({
 *     street: z.string(),
 *     city: z.string(),
 *   }),
 * });
 *
 * const fields = zodToFields(schema);
 * // Returns:
 * // [
 * //   { name: "name", type: "text", required: true, ... },
 * //   { name: "email", type: "text", required: true, hint: "email", ... },
 * //   { name: "age", type: "number", required: false, ... },
 * //   { name: "role", type: "select", options: ["admin", "user"], ... },
 * //   { name: "isActive", type: "checkbox", defaultValue: true, ... },
 * //   { name: "address", nested: [...], ... },
 * // ]
 *
 * // Render form HTML
 * const html = renderForm(fields, "create", {
 *   name: "John",
 *   email: "john@example.com",
 * });
 *
 * // Render single field
 * const fieldHtml = renderField(fields[0], { name: "Jane" });
 * ```
 */

import type { z } from "zod";
import {
  getDefaultValue,
  getEnumValues,
  getInnerType,
  getLiteralValue,
  getNativeEnumValues,
  getShape,
  getStringChecks,
  getTypeName,
} from "../../shared/zod-compat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldDescriptor {
  name: string;
  label: string;
  type:
    | "text"
    | "number"
    | "checkbox"
    | "datetime-local"
    | "select"
    | "textarea";
  required: boolean;
  nullable: boolean;
  options?: string[]; // for select
  defaultValue?: unknown;
  nested?: FieldDescriptor[]; // for objects
  hint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert camelCase / snake_case to "Human Label" */
function toLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\s/, "")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Unwrap ZodOptional / ZodNullable / ZodDefault to the inner schema */
function unwrap(schema: z.ZodType): {
  inner: z.ZodType;
  required: boolean;
  nullable: boolean;
  defaultValue: unknown;
} {
  let inner: z.ZodType = schema;
  let required = true;
  let nullable = false;
  let defaultValue: unknown = undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = getTypeName(inner);
    if (tn === "ZodOptional") {
      required = false;
      inner = getInnerType(inner)!;
    } else if (tn === "ZodNullable") {
      required = false;
      nullable = true;
      inner = getInnerType(inner)!;
    } else if (tn === "ZodDefault") {
      required = false;
      defaultValue = getDefaultValue(inner);
      inner = getInnerType(inner)!;
    } else {
      break;
    }
  }

  return { inner, required, nullable, defaultValue };
}

// ---------------------------------------------------------------------------
// Core introspection
// ---------------------------------------------------------------------------

export function zodToFields(
  schema: z.ZodType,
  namePrefix = "",
): FieldDescriptor[] {
  const tn = getTypeName(schema);

  if (tn === "ZodObject") {
    const shape: Record<string, z.ZodType> = getShape(schema);
    return Object.entries(shape).map(([fieldName, fieldSchema]) =>
      zodFieldToDescriptor(
        namePrefix ? `${namePrefix}.${fieldName}` : fieldName,
        fieldName,
        fieldSchema,
      ),
    );
  }

  // If the root schema is not an object, treat it as a single field
  return [
    zodFieldToDescriptor(namePrefix || "value", namePrefix || "value", schema),
  ];
}

function zodFieldToDescriptor(
  name: string,
  rawName: string,
  schema: z.ZodType,
): FieldDescriptor {
  const { inner, required, nullable, defaultValue } = unwrap(schema);
  const tn = getTypeName(inner);
  const label = toLabel(rawName.split(".").pop() ?? rawName);

  switch (tn) {
    case "ZodString": {
      const checks = getStringChecks(inner);
      const isEmail = checks.includes("email");
      const isUrl = checks.includes("url");
      return {
        name,
        label,
        type: "text",
        required,
        nullable,
        defaultValue,
        hint: isEmail ? "email" : isUrl ? "url" : undefined,
      };
    }

    case "ZodNumber":
    case "ZodBigInt":
      return { name, label, type: "number", required, nullable, defaultValue };

    case "ZodBoolean":
      return {
        name,
        label,
        type: "checkbox",
        required,
        nullable,
        defaultValue,
      };

    case "ZodDate":
    case "ZodCoerce":
      return {
        name,
        label,
        type: "datetime-local",
        required,
        nullable,
        defaultValue,
      };

    case "ZodEnum": {
      const values = getEnumValues(inner);
      return {
        name,
        label,
        type: "select",
        required,
        nullable,
        defaultValue,
        options: values,
      };
    }

    case "ZodNativeEnum": {
      const enumObj = getNativeEnumValues(inner);
      const values = Object.values(enumObj).filter(
        (v) => typeof v === "string",
      ) as string[];
      return {
        name,
        label,
        type: "select",
        required,
        nullable,
        defaultValue,
        options: values,
      };
    }

    case "ZodLiteral": {
      const value = String(getLiteralValue(inner) ?? "");
      return {
        name,
        label,
        type: "select",
        required,
        nullable,
        defaultValue,
        options: [value],
      };
    }

    case "ZodObject": {
      const nested = zodToFields(inner, name);
      return {
        name,
        label,
        type: "textarea",
        required,
        nullable,
        defaultValue,
        nested,
        hint: "JSON object",
      };
    }

    case "ZodArray":
      return {
        name,
        label,
        type: "textarea",
        required,
        nullable,
        defaultValue,
        hint: "JSON array",
      };

    default:
      return {
        name,
        label,
        type: "textarea",
        required,
        nullable,
        defaultValue,
        hint: "JSON",
      };
  }
}

// ---------------------------------------------------------------------------
// HTML generation — DaisyUI + Tailwind classes
// ---------------------------------------------------------------------------

export function renderField(field: FieldDescriptor, depth = 0): string {
  const indent = depth > 0 ? `ml-${depth * 4}` : "";
  const id = `field_${field.name.replace(/\./g, "__")}`;
  const nameAttr = field.name;
  const requiredAttr = field.required ? " required" : "";
  // "__null__" is the sentinel value used when a nullable field is set to null
  const isNullValue = field.defaultValue === "__null__";
  const defaultStr =
    !isNullValue && field.defaultValue != null
      ? String(field.defaultValue)
      : "";

  // Null toggle — rendered inline to the right of the input for nullable non-checkbox fields
  const nullToggle =
    field.nullable && field.type !== "checkbox"
      ? `<span class="flex items-center gap-1 shrink-0">
          <input type="hidden" id="${id}__isnull" name="${nameAttr}__isnull" value="${isNullValue ? "1" : ""}">
          <label class="flex items-center gap-1 cursor-pointer select-none text-xs text-base-content/40 hover:text-base-content/70 border border-base-300 rounded px-2 py-1">
            <input type="checkbox" class="checkbox checkbox-xs" ${isNullValue ? "checked" : ""}
              onchange="(function(cb){
                var inp = document.getElementById('${id}');
                var h = document.getElementById('${id}__isnull');
                if (cb.checked) { inp.disabled=true; inp.style.opacity='0.35'; h.value='1'; }
                else { inp.disabled=false; inp.style.opacity=''; h.value=''; }
              })(this)">
            <span>null</span>
          </label>
        </span>`
      : "";

  let input: string;

  switch (field.type) {
    case "checkbox":
      // Nullable boolean → 3-state select (null / true / false)
      if (field.nullable) {
        const sel3 = isNullValue
          ? "__null__"
          : defaultStr === "true"
            ? "true"
            : defaultStr === "false"
              ? "false"
              : "__null__";
        return `
      <div class="form-control mb-3 ${indent}">
        <label for="${id}" class="label pb-1">
          <span class="label-text font-medium">
            ${e(field.label)}
            <span class="text-base-content/40 text-xs ml-1">(nullable)</span>
          </span>
        </label>
        <select id="${id}" name="${nameAttr}" class="select select-bordered select-sm w-full">
          <option value="__null__"${sel3 === "__null__" ? " selected" : ""}>— null —</option>
          <option value="true"${sel3 === "true" ? " selected" : ""}>✓ true</option>
          <option value="false"${sel3 === "false" ? " selected" : ""}>✗ false</option>
        </select>
      </div>`;
      }
      return `
      <div class="form-control ${indent}">
        <label class="label cursor-pointer justify-start gap-3">
          <input type="checkbox" id="${id}" name="${nameAttr}" value="true"${
            defaultStr === "true" ? " checked" : ""
          } class="checkbox checkbox-primary checkbox-sm">
          <span class="label-text font-medium">
            ${e(field.label)}${field.required ? ` <span class="text-error">*</span>` : ""}
          </span>
        </label>
      </div>`;

    case "select":
      input = `<select id="${id}" name="${nameAttr}"${requiredAttr}${isNullValue ? ' disabled style="opacity:0.35"' : ""} class="select select-bordered select-sm w-full">
        ${field.required && !field.nullable ? "" : `<option value="">— optional —</option>`}
        ${(field.options ?? []).map((o) => `<option value="${e(o)}"${defaultStr === o ? " selected" : ""}>${e(o)}</option>`).join("\n        ")}
      </select>`;
      break;

    case "textarea":
      if (field.nested && field.nested.length > 0) {
        const subFields = field.nested
          .map((f) => renderField(f, depth + 1))
          .join("\n");
        return `
      <fieldset class="fieldset border border-base-300 rounded-box p-3 mb-3 ${indent}">
        <legend class="fieldset-legend text-xs font-semibold text-base-content/60 px-1">
          ${e(field.label)}${field.required ? ` <span class="text-error">*</span>` : ""}
        </legend>
        ${subFields}
      </fieldset>`;
      }
      input = `<textarea id="${id}" name="${nameAttr}"${requiredAttr} rows="3"${isNullValue ? ' disabled style="opacity:0.35"' : ""}
        data-json
        class="textarea textarea-bordered textarea-sm w-full font-mono text-xs"
        placeholder="${e(field.hint ?? "JSON")}">${e(defaultStr)}</textarea>`;
      break;

    default:
      input = `<input type="${field.type}" id="${id}" name="${nameAttr}"${requiredAttr}${isNullValue ? ' disabled style="opacity:0.35"' : ""}
        value="${e(defaultStr)}"
        class="input input-bordered input-sm w-full"${
          field.hint === "email"
            ? ' autocomplete="email"'
            : field.hint === "url"
              ? ' autocomplete="url"'
              : ""
        }>`;
  }

  return `
      <div class="form-control mb-3 ${indent}">
        <label for="${id}" class="label pb-1">
          <span class="label-text font-medium">
            ${e(field.label)}${field.required ? ` <span class="text-error">*</span>` : ""}
            ${field.hint ? `<span class="text-base-content/40 text-xs ml-1">(${e(field.hint)})</span>` : ""}
          </span>
        </label>
        <div class="flex items-center gap-2">
          <div class="flex-1 min-w-0">${input}</div>
          ${nullToggle}
        </div>
      </div>`;
}

/** Minimal HTML escape */
function e(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderForm(
  fields: FieldDescriptor[],
  action: string,
  method: "GET" | "POST",
  submitLabel = "Save",
): string {
  const fieldsHtml = fields.map((f) => renderField(f)).join("\n");
  return `
    <form action="${e(action)}" method="${method}" novalidate data-frs-form>
      ${fieldsHtml}
      <div class="flex gap-2 mt-4 pt-4 border-t border-base-200">
        <button type="submit" class="btn btn-primary btn-sm">${e(submitLabel)}</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="history.back()">Cancel</button>
      </div>
    </form>`;
}
