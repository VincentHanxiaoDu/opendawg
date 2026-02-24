import { input, confirm, select, password } from '@inquirer/prompts';
import type { ConfigFieldSchema } from '../lib/plugin-manifest.js';

/**
 * Interactively prompt the user for config values based on a plugin schema.
 * Pre-fills with `existing` values when available. Secret fields use password input.
 */
export async function promptForConfig(
  schema: Record<string, ConfigFieldSchema>,
  existing?: Record<string, any>,
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};

  for (const [key, field] of Object.entries(schema)) {
    const existingValue = existing?.[key];
    const hasExisting = existingValue !== undefined && existingValue !== null;

    const label = field.description ?? key;
    const requiredTag = field.required ? ' (required)' : '';

    switch (field.type) {
      case 'boolean': {
        const defaultVal = hasExisting ? Boolean(existingValue) : field.default ?? false;
        result[key] = await confirm({
          message: `${label}${requiredTag}`,
          default: defaultVal,
        });
        break;
      }

      case 'integer': {
        const defaultVal = hasExisting ? String(existingValue) : field.default !== undefined ? String(field.default) : '';
        if (field.secret) {
          const raw = await password({
            message: `${label}${requiredTag}`,
          });
          const parsed = parseInt(raw, 10);
          if (Number.isNaN(parsed)) {
            throw new Error(`Invalid integer value for "${key}": ${raw}`);
          }
          result[key] = parsed;
        } else {
          const raw = await input({
            message: `${label}${requiredTag}`,
            default: defaultVal,
            validate: (val) => {
              if (field.required && val.trim() === '') return 'This field is required';
              if (val.trim() !== '' && Number.isNaN(parseInt(val, 10))) return 'Must be an integer';
              return true;
            },
          });
          result[key] = raw.trim() === '' ? field.default : parseInt(raw, 10);
        }
        break;
      }

      case 'array': {
        const defaultVal = hasExisting
          ? Array.isArray(existingValue)
            ? existingValue.join(', ')
            : String(existingValue)
          : Array.isArray(field.default)
            ? field.default.join(', ')
            : '';
        const raw = await input({
          message: `${label} (comma-separated)${requiredTag}`,
          default: defaultVal,
          validate: (val) => {
            if (field.required && val.trim() === '') return 'This field is required';
            return true;
          },
        });
        result[key] = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      }

      case 'string':
      default: {
        const defaultVal = hasExisting ? String(existingValue) : field.default !== undefined ? String(field.default) : '';

        if (field.secret) {
          result[key] = await password({
            message: `${label}${requiredTag}`,
            validate: (val) => {
              if (field.required && val.trim() === '') return 'This field is required';
              return true;
            },
          });
        } else {
          result[key] = await input({
            message: `${label}${requiredTag}`,
            default: defaultVal,
            validate: (val) => {
              if (field.required && val.trim() === '') return 'This field is required';
              return true;
            },
          });
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Prompt the user to select from a list of choices.
 */
export async function promptSelect<T extends string>(
  message: string,
  choices: { name: string; value: T }[],
): Promise<T> {
  return select({ message, choices });
}

/**
 * Prompt for a yes/no confirmation.
 */
export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}
