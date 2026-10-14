import { AdapterError } from './types.js';
import type { NativeOperation } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = match;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) return false;
  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  return Number(day) >= 1 && Number(day) <= daysInMonth;
}

export function validateParameters(operation: NativeOperation, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new AdapterError('INPUT_INVALID', 'Operation arguments must be a JSON object.');
  const schema = operation.inputSchema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(properties, key)) throw new AdapterError('INPUT_INVALID', 'Operation arguments contain an unknown parameter.');
  }
  for (const [key, field] of Object.entries(properties)) {
    const value = Object.hasOwn(input, key) ? input[key] : field.default;
    if (value === undefined) continue;
    let valid = true;
    if (field.type === 'string') {
      valid = typeof value === 'string';
      if (typeof value === 'string') {
        valid = valid && value.length >= Number(field.minLength ?? 0) && value.length <= Number(field.maxLength ?? Infinity);
        valid = valid && !/[\u0000-\u001f\u007f]/.test(value);
        if (typeof field.pattern === 'string') valid = valid && new RegExp(field.pattern).test(value);
        if (field.format === 'date-time') valid = valid && validTimestamp(value);
      }
    } else if (field.type === 'integer') {
      valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= Number(field.minimum ?? -Infinity) && value <= Number(field.maximum ?? Infinity);
    } else if (field.type === 'boolean') {
      valid = typeof value === 'boolean';
    }
    if (Array.isArray(field.enum)) valid = valid && field.enum.includes(value);
    if (!valid) throw new AdapterError('INPUT_INVALID', `Parameter ${key} does not match its declared schema.`);
    output[key] = value;
  }
  for (const key of schema.required as string[]) {
    if (!Object.hasOwn(output, key)) throw new AdapterError('INPUT_INVALID', `Required parameter ${key} is missing.`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((branch: unknown) => isRecord(branch) && Array.isArray(branch.required) && branch.required.every((key: unknown) => typeof key === 'string' && Object.hasOwn(output, key)));
    if (matched.length !== 1) throw new AdapterError('INPUT_INVALID', 'Provide exactly one of id or slug.');
  }
  if (typeof output.postedAfter === 'string' && typeof output.postedBefore === 'string' && Date.parse(output.postedAfter) >= Date.parse(output.postedBefore)) {
    throw new AdapterError('INPUT_INVALID', 'postedAfter must be earlier than postedBefore.');
  }
  return output;
}
