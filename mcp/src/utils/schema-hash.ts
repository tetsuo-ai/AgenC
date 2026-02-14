import { createHash } from 'node:crypto';
import type { ZodTypeAny } from 'zod';

type JsonLike =
  | null
  | boolean
  | number
  | string
  | readonly JsonLike[]
  | { readonly [key: string]: JsonLike };

function normalizeLiteral(value: unknown): JsonLike {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeLiteral(entry));
  }
  if (typeof value === 'object') {
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
  return checks.map((check) => {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) {
      return check;
    }
    const record = check as Record<string, unknown>;
    // Message changes are not meaningful schema shape changes.
    const { message: _message, ...rest } = record;
    return rest;
  });
}

function extractSchemaDescription(schema: ZodTypeAny): unknown {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shapeFn = def.shape as (() => Record<string, ZodTypeAny>) | undefined;
      const shape = shapeFn ? shapeFn() : {};
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(shape).sort()) {
        fields[key] = extractSchemaDescription(shape[key]);
      }
      return {
        type: 'object',
        fields,
        unknownKeys: def.unknownKeys,
        catchall: def.catchall ? extractSchemaDescription(def.catchall as ZodTypeAny) : undefined,
      };
    }
    case 'ZodArray':
      return { type: 'array', element: extractSchemaDescription(def.type as ZodTypeAny) };
    case 'ZodString':
      return { type: 'string', checks: stripCheckMessages(def.checks) };
    case 'ZodNumber':
      return { type: 'number', checks: stripCheckMessages(def.checks), coerce: def.coerce };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { type: 'literal', value: normalizeLiteral(def.value) };
    case 'ZodEnum':
      return { type: 'enum', values: normalizeLiteral(def.values) };
    case 'ZodNativeEnum':
      return { type: 'nativeEnum', values: normalizeLiteral(def.values) };
    case 'ZodOptional':
      return { type: 'optional', inner: extractSchemaDescription(def.innerType as ZodTypeAny) };
    case 'ZodNullable':
      return { type: 'nullable', inner: extractSchemaDescription(def.innerType as ZodTypeAny) };
    case 'ZodDefault':
      return { type: 'default', inner: extractSchemaDescription(def.innerType as ZodTypeAny) };
    case 'ZodRecord':
      return {
        type: 'record',
        key: def.keyType ? extractSchemaDescription(def.keyType as ZodTypeAny) : undefined,
        value: extractSchemaDescription(def.valueType as ZodTypeAny),
      };
    case 'ZodUnion':
      return { type: 'union', options: (def.options as ZodTypeAny[]).map((entry) => extractSchemaDescription(entry)) };
    case 'ZodUnknown':
      return { type: 'unknown' };
    case 'ZodAny':
      return { type: 'any' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodNever':
      return { type: 'never' };
    case 'ZodEffects':
      return { type: 'effects', inner: extractSchemaDescription(def.schema as ZodTypeAny) };
    default:
      return { type: typeof typeName === 'string' ? typeName : 'unknown' };
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
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

