import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";

type JsonLike =
  | null
  | boolean
  | number
  | string
  | readonly JsonLike[]
  | { readonly [key: string]: JsonLike };

function normalizeLiteral(value: unknown): JsonLike {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeLiteral(entry));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, JsonLike> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeLiteral(record[key]);
    }
    return out;
  }
  return String(value);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeLiteral(value));
}

function stripCheckMessages(checks: unknown): unknown {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.map((check) => normalizeCheck(check));
}

function normalizeCheck(check: unknown): JsonLike {
  if (check === null || typeof check !== "object" || Array.isArray(check)) {
    return normalizeLiteral(check);
  }
  const record = check as {
    readonly def?: Record<string, unknown>;
    readonly _zod?: { readonly def?: Record<string, unknown> };
  };
  const payload = record._zod?.def ?? record.def ?? (check as Record<string, unknown>);
  const normalized: Record<string, JsonLike> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === "message" || key === "when" || key === "fn") {
      continue;
    }
    normalized[key] = normalizeLiteral(payload[key]);
  }
  return normalized;
}

function getSchemaDef(schema: ZodTypeAny): Record<string, unknown> {
  return (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};
}

function getSchemaType(schema: ZodTypeAny): string {
  const def = getSchemaDef(schema);
  const typeName =
    typeof def.typeName === "string"
      ? def.typeName
      : typeof def.type === "string"
        ? def.type
        : "unknown";
  return typeName.replace(/^Zod/, "").toLowerCase();
}

function extractSchemaDescription(schema: ZodTypeAny): unknown {
  const def = getSchemaDef(schema);
  const typeName = getSchemaType(schema);

  switch (typeName) {
    case "object": {
      const shapeFn = def.shape as
        | Record<string, ZodTypeAny>
        | (() => Record<string, ZodTypeAny>)
        | undefined;
      const shape =
        typeof shapeFn === "function"
          ? shapeFn()
          : shapeFn ?? {};
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(shape).sort()) {
        fields[key] = extractSchemaDescription(shape[key]);
      }
      return {
        type: "object",
        fields,
        unknownKeys: def.unknownKeys,
        catchall: def.catchall
          ? extractSchemaDescription(def.catchall as ZodTypeAny)
          : undefined,
      };
    }
    case "array":
      return {
        type: "array",
        element: extractSchemaDescription(
          (def.element ?? def.type) as ZodTypeAny,
        ),
      };
    case "string":
      return { type: "string", checks: stripCheckMessages(def.checks) };
    case "number":
      return {
        type: "number",
        checks: stripCheckMessages(def.checks),
        coerce: def.coerce,
      };
    case "boolean":
      return { type: "boolean" };
    case "literal":
      return {
        type: "literal",
        value: normalizeLiteral(
          def.value ?? (Array.isArray(def.values) ? def.values[0] : undefined),
        ),
      };
    case "enum":
      return {
        type: "enum",
        values: normalizeLiteral(
          def.values ??
            (def.entries && typeof def.entries === "object"
              ? Object.values(def.entries as Record<string, unknown>).sort()
              : undefined),
        ),
      };
    case "nativeenum":
      return { type: "nativeEnum", values: normalizeLiteral(def.values) };
    case "optional":
      return {
        type: "optional",
        inner: extractSchemaDescription(def.innerType as ZodTypeAny),
      };
    case "nullable":
      return {
        type: "nullable",
        inner: extractSchemaDescription(def.innerType as ZodTypeAny),
      };
    case "default":
      return {
        type: "default",
        inner: extractSchemaDescription(def.innerType as ZodTypeAny),
      };
    case "record":
      return {
        type: "record",
        key: def.keyType
          ? extractSchemaDescription(def.keyType as ZodTypeAny)
          : undefined,
        value: extractSchemaDescription(def.valueType as ZodTypeAny),
      };
    case "union":
      return {
        type: "union",
        options: (def.options as ZodTypeAny[]).map((entry) =>
          extractSchemaDescription(entry),
        ),
      };
    case "unknown":
      return { type: "unknown" };
    case "any":
      return { type: "any" };
    case "null":
      return { type: "null" };
    case "never":
      return { type: "never" };
    case "effects":
      return {
        type: "effects",
        inner: extractSchemaDescription(def.schema as ZodTypeAny),
      };
    case "pipe":
      return {
        type: "pipe",
        input: extractSchemaDescription(def.in as ZodTypeAny),
        output: extractSchemaDescription(def.out as ZodTypeAny),
      };
    default:
      return { type: typeName };
  }
}

/**
 * Compute a deterministic hash of a Zod schema's shape.
 *
 * The hash captures the schema's structural definition so that any
 * change to the schema (added/removed fields, type changes, constraint changes)
 * produces a different hash.
 */
export function computeSchemaHash(schema: ZodTypeAny): string {
  const description = extractSchemaDescription(schema);
  const serialized = stableJsonStringify(description);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}
