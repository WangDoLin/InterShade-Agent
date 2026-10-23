import { z } from 'zod';

const RAW_JSON_SCHEMA_SYMBOL = Symbol.for('intershader.zod.rawJsonSchema');

export class UnsupportedZodSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedZodSchemaError';
  }
}

export interface ZodToJsonSchemaOptions {
  /**
   * When true (default), throws UnsupportedZodSchemaError on unrecognized schema types
   * instead of failing open to `{ type: 'string' }`.
   */
  strict?: boolean;
  /**
   * Optional tool/schema name for diagnostic context.
   */
  schemaName?: string;
}

/**
 * Attaches an upstream JSON Schema (such as an MCP server's tool inputSchema)
 * onto a Zod validator so `zodToJsonSchema` preserves the exact upstream parameter definitions (NEXT-A-15).
 */
export function attachRawJsonSchema<T extends z.ZodType<any, any, any>>(
  schema: T,
  rawJsonSchema: Record<string, unknown> | undefined
): T {
  if (rawJsonSchema && typeof rawJsonSchema === 'object') {
    Object.defineProperty(schema, RAW_JSON_SCHEMA_SYMBOL, {
      value: rawJsonSchema,
      enumerable: false,
      configurable: true,
    });
  }
  return schema;
}

/**
 * Retrieves an attached upstream JSON Schema if present.
 */
export function getAttachedRawJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema && typeof schema === 'object' && RAW_JSON_SCHEMA_SYMBOL in schema) {
    return (schema as Record<symbol, Record<string, unknown>>)[RAW_JSON_SCHEMA_SYMBOL];
  }
  return undefined;
}

/**
 * Formats a ZodError into a concise, deterministic human/LLM-readable string
 * without relying on deprecated `.format()`, `.flatten()`, or `.errors` APIs (NEXT-A-06).
 */
export function formatZodError(error: z.ZodError): string {
  const zAny = z as unknown as {
    prettifyError?: (err: z.ZodError) => string;
  };
  if (typeof zAny.prettifyError === 'function') {
    return zAny.prettifyError(error);
  }

  if (!error.issues || error.issues.length === 0) {
    return error.message || 'Validation failed';
  }

  return error.issues
    .map((issue) => {
      const pathStr = issue.path && issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${pathStr}: ${issue.message} (${issue.code})`;
    })
    .join('; ');
}

/**
 * Converts a Zod Schema into standard JSON Schema for Anthropic, OpenAI, Gemini, and MCP tool calling.
 * Eliminates legacy fail-open `{ type: 'string' }` fallback (ADR-A1 / NEXT-A-05).
 */
export function zodToJsonSchema(
  schema: z.ZodType<unknown>,
  options: ZodToJsonSchemaOptions = {}
): Record<string, unknown> {
  const attachedRaw = getAttachedRawJsonSchema(schema);
  if (attachedRaw) {
    return normalizeTopLevelObjectSchema(structuredClone(attachedRaw));
  }

  // If native z.toJSONSchema is available (Zod 4+) and strict custom normalization is compatible
  const zWithJson = z as unknown as {
    toJSONSchema?: (s: unknown, opts?: Record<string, unknown>) => Record<string, unknown>;
  };
  if (typeof zWithJson.toJSONSchema === 'function') {
    try {
      const converted = zWithJson.toJSONSchema(schema, { target: 'draft-2020-12' });
      const { $schema: _omitted, ...rest } = converted;
      return normalizeTopLevelObjectSchema(rest);
    } catch (err) {
      if (options.strict !== false) {
        throw new UnsupportedZodSchemaError(
          `Failed to convert Zod schema${options.schemaName ? ` (${options.schemaName})` : ''}: ${(err as Error).message}`
        );
      }
    }
  }

  const converted = convertZodNode(schema, options);
  return converted;
}

function normalizeTopLevelObjectSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };
  if (!result.type) {
    result.type = 'object';
  }
  if (result.type === 'object' && !result.properties && !result.additionalProperties) {
    result.properties = {};
  }
  return result;
}

function isFieldOptionalOrDefaulted(field: z.ZodType<unknown>): boolean {
  if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
    return true;
  }
  if (field instanceof z.ZodNullable) {
    return isFieldOptionalOrDefaulted(field.unwrap());
  }
  if (field instanceof z.ZodEffects) {
    return isFieldOptionalOrDefaulted(field.innerType());
  }
  try {
    return field.safeParse(undefined).success;
  } catch {
    return false;
  }
}

function convertZodNode(
  node: unknown,
  options: ZodToJsonSchemaOptions
): Record<string, unknown> {
  if (!node || typeof node !== 'object' || !(node instanceof z.ZodType)) {
    if (options.strict !== false) {
      throw new UnsupportedZodSchemaError(
        `Invalid or non-Zod schema encountered${options.schemaName ? ` in ${options.schemaName}` : ''}.`
      );
    }
    return { type: 'object', properties: {} };
  }

  const attachedRaw = getAttachedRawJsonSchema(node);
  if (attachedRaw) {
    return structuredClone(attachedRaw);
  }

  let description: string | undefined = node.description;
  let isNullable = false;
  let defaultValue: unknown = undefined;
  let hasDefault = false;
  let current: z.ZodType<unknown> = node;

  // Unwrap arbitrary chains of Optional, Nullable, Default, and Effects
  let unwrapGuard = 0;
  while (unwrapGuard < 16) {
    unwrapGuard++;
    if (!description && current.description) {
      description = current.description;
    }

    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodNullable) {
      isNullable = true;
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      hasDefault = true;
      const parsedDefault = current.safeParse(undefined);
      if (parsedDefault.success) {
        defaultValue = parsedDefault.data;
      }
      current = current.removeDefault();
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    break;
  }

  if (!description && current.description) {
    description = current.description;
  }

  let result: Record<string, unknown>;

  if (current instanceof z.ZodObject) {
    const shape = current.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = convertZodNode(fieldSchema, {
        ...options,
        schemaName: options.schemaName ? `${options.schemaName}.${key}` : key,
      });

      if (!isFieldOptionalOrDefaulted(fieldSchema)) {
        required.push(key);
      }
    }

    result = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } else if (current instanceof z.ZodString) {
    result = { type: 'string' };
  } else if (current instanceof z.ZodNumber) {
    result = { type: 'number' };
  } else if (current instanceof z.ZodBoolean) {
    result = { type: 'boolean' };
  } else if (current instanceof z.ZodArray) {
    result = {
      type: 'array',
      items: convertZodNode(current.element, options),
    };
  } else if (current instanceof z.ZodEnum) {
    result = {
      type: 'string',
      enum: current.options,
    };
  } else if (current instanceof z.ZodNativeEnum) {
    const rawValues = Object.values(current.enum as Record<string, string | number>);
    const hasNumbers = rawValues.some((v) => typeof v === 'number');
    const enumValues = hasNumbers
      ? rawValues.filter((v) => typeof v === 'number')
      : rawValues;
    result = {
      type: hasNumbers ? 'number' : 'string',
      enum: enumValues,
    };
  } else if (current instanceof z.ZodLiteral) {
    const litVal = current.value;
    const litType =
      typeof litVal === 'string'
        ? 'string'
        : typeof litVal === 'number'
        ? 'number'
        : typeof litVal === 'boolean'
        ? 'boolean'
        : undefined;
    result = {
      ...(litType ? { type: litType } : {}),
      const: litVal,
      enum: [litVal],
    };
  } else if (current instanceof z.ZodUnion || current instanceof z.ZodDiscriminatedUnion) {
    const unionOptions = (current as unknown as { options: z.ZodType<unknown>[] }).options;
    result = {
      anyOf: unionOptions.map((opt) => convertZodNode(opt, options)),
    };
  } else if (current instanceof z.ZodRecord) {
    const valueSchema = (current as unknown as { valueSchema: z.ZodType<unknown> }).valueSchema;
    const valueJson =
      valueSchema instanceof z.ZodAny || valueSchema instanceof z.ZodUnknown
        ? true
        : convertZodNode(valueSchema, options);
    result = {
      type: 'object',
      additionalProperties: valueJson,
    };
  } else if (current instanceof z.ZodTuple) {
    const items = (current as unknown as { items: z.ZodType<unknown>[] }).items;
    result = {
      type: 'array',
      prefixItems: items.map((item) => convertZodNode(item, options)),
      minItems: items.length,
      maxItems: items.length,
    };
  } else if (current instanceof z.ZodAny || current instanceof z.ZodUnknown) {
    result = {};
  } else {
    if (options.strict !== false) {
      throw new UnsupportedZodSchemaError(
        `Unsupported Zod schema constructor "${current.constructor?.name || 'Unknown'}"${
          options.schemaName ? ` at "${options.schemaName}"` : ''
        }. Fail-open fallback to { type: 'string' } is disabled.`
      );
    }
    result = { type: 'string' };
  }

  if (isNullable) {
    result.nullable = true;
  }
  if (hasDefault && defaultValue !== undefined) {
    result.default = defaultValue;
  }
  if (description !== undefined) {
    result.description = description;
  }

  return result;
}
