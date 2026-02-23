import type { ConfigFieldSchema } from './plugin-manifest.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a set of config values against a plugin config schema.
 * Returns an array of validation errors (empty means all values are valid).
 */
export function validateConfig(
  values: Record<string, any>,
  schema: Record<string, ConfigFieldSchema>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = values[field];

    // Required check
    if (fieldSchema.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, message: `"${field}" is required` });
      continue;
    }

    // Skip validation if the value is absent and not required
    if (value === undefined || value === null) {
      continue;
    }

    // Type check
    switch (fieldSchema.type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push({ field, message: `"${field}" must be a string, got ${typeof value}` });
        }
        break;

      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push({ field, message: `"${field}" must be an integer` });
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ field, message: `"${field}" must be a boolean, got ${typeof value}` });
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          errors.push({ field, message: `"${field}" must be an array, got ${typeof value}` });
        }
        break;

      default:
        errors.push({ field, message: `Unknown schema type "${fieldSchema.type}" for "${field}"` });
    }
  }

  // Warn about unknown fields (fields present in values but not in schema)
  for (const key of Object.keys(values)) {
    if (!(key in schema)) {
      errors.push({ field: key, message: `Unknown config field "${key}"` });
    }
  }

  return errors;
}

/**
 * Apply default values from the schema to the given config values.
 * Only fills in fields that are undefined/null in `values`.
 * Returns a new object — does not mutate the input.
 */
export function applyDefaults(
  values: Record<string, any>,
  schema: Record<string, ConfigFieldSchema>,
): Record<string, any> {
  const result: Record<string, any> = { ...values };

  for (const [field, fieldSchema] of Object.entries(schema)) {
    if ((result[field] === undefined || result[field] === null) && fieldSchema.default !== undefined) {
      // Deep copy defaults that are objects/arrays to avoid shared references
      result[field] =
        typeof fieldSchema.default === 'object' && fieldSchema.default !== null
          ? JSON.parse(JSON.stringify(fieldSchema.default))
          : fieldSchema.default;
    }
  }

  return result;
}

/**
 * Mask secret fields in config values for safe display.
 * Fields marked `secret: true` in the schema are replaced with "****".
 * Returns a new object — does not mutate the input.
 */
export function maskSecrets(
  values: Record<string, any>,
  schema: Record<string, ConfigFieldSchema>,
): Record<string, any> {
  const result: Record<string, any> = { ...values };

  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.secret && result[field] !== undefined && result[field] !== null) {
      result[field] = '****';
    }
  }

  return result;
}

/**
 * Coerce string values into the types declared in the schema.
 * Useful when reading values from environment variables or user input.
 * Returns a new object — does not mutate the input.
 */
export function coerceTypes(
  values: Record<string, any>,
  schema: Record<string, ConfigFieldSchema>,
): Record<string, any> {
  const result: Record<string, any> = { ...values };

  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = result[field];
    if (value === undefined || value === null) continue;

    // Only coerce if the value is a string and the target type is different
    if (typeof value !== 'string') continue;

    switch (fieldSchema.type) {
      case 'integer': {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          result[field] = parsed;
        }
        break;
      }
      case 'boolean': {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') {
          result[field] = true;
        } else if (lower === 'false' || lower === '0' || lower === 'no') {
          result[field] = false;
        }
        break;
      }
      case 'array': {
        // Accept comma-separated strings
        result[field] = value
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        break;
      }
      // 'string' — no coercion needed
    }
  }

  return result;
}
