/**
 * Minimal JSON Schema validator for skill input / output boundaries.
 *
 * The codebase has zod available but no Ajv; the data-analyzer
 * already hand-rolls schema parsing for its result-parser, and
 * pulling in Ajv just for the skill registry is over-weighted given
 * the surface area we need.
 *
 * Supported keywords (Draft-07-style subset):
 *
 *   type:        'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'
 *                or array of the above
 *   properties   recursive validation per key
 *   required     non-empty + present check
 *   enum         exact membership
 *   minimum / maximum (numeric)
 *   minItems / maxItems
 *   items        array element schema (single schema, not tuple)
 *   additionalProperties: false  rejects unknown keys
 *
 * Out of scope on purpose: oneOf / anyOf / allOf, regex patterns,
 * format validators, $ref, conditional keywords. Skill schemas that
 * need richer typing should hand-roll a follow-up parser inside the
 * skill body; the registry's job is to catch the common mistakes,
 * not to be a full JSON Schema implementation.
 */

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validate(
  value: unknown,
  schema: Record<string, unknown>,
  path: string = '',
): ValidationResult {
  const errors: string[] = [];
  walk(value, schema, path, errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function walk(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  // Type check (single string or array of strings).
  const typeKw = schema['type'];
  if (typeof typeKw === 'string') {
    if (!checkType(value, typeKw)) {
      errors.push(`${path || '<root>'}: expected type '${typeKw}', got '${typeOf(value)}'`);
      return;
    }
  } else if (Array.isArray(typeKw)) {
    const matched = typeKw.some(t => typeof t === 'string' && checkType(value, t));
    if (!matched) {
      errors.push(`${path || '<root>'}: expected one of [${typeKw.join(', ')}], got '${typeOf(value)}'`);
      return;
    }
  }

  // Enum check.
  const enumKw = schema['enum'];
  if (Array.isArray(enumKw)) {
    if (!enumKw.some(e => deepEqual(e, value))) {
      errors.push(`${path || '<root>'}: value not in enum`);
    }
  }

  // Numeric bounds.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const min = schema['minimum'];
    if (typeof min === 'number' && value < min) {
      errors.push(`${path || '<root>'}: ${value} < minimum ${min}`);
    }
    const max = schema['maximum'];
    if (typeof max === 'number' && value > max) {
      errors.push(`${path || '<root>'}: ${value} > maximum ${max}`);
    }
  }

  // Array constraints.
  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      errors.push(`${path || '<root>'}: array length ${value.length} < minItems ${minItems}`);
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      errors.push(`${path || '<root>'}: array length ${value.length} > maxItems ${maxItems}`);
    }
    const items = schema['items'];
    if (items !== undefined && typeof items === 'object' && items !== null && !Array.isArray(items)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], items as Record<string, unknown>, `${path}[${i}]`, errors);
      }
    }
  }

  // Object constraints.
  if (isPlainObject(value)) {
    const properties = schema['properties'];
    const propMap = isPlainObject(properties) ? properties as Record<string, unknown> : undefined;
    const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter(s => typeof s === 'string') as string[] : [];

    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path || '<root>'}: missing required property '${key}'`);
      }
    }

    if (propMap !== undefined) {
      for (const [key, subSchema] of Object.entries(propMap)) {
        if (key in value && isPlainObject(subSchema)) {
          walk((value as Record<string, unknown>)[key], subSchema, path ? `${path}.${key}` : key, errors);
        }
      }
    }

    if (schema['additionalProperties'] === false && propMap !== undefined) {
      for (const key of Object.keys(value)) {
        if (!(key in propMap)) {
          errors.push(`${path || '<root>'}: unexpected property '${key}'`);
        }
      }
    }
  }
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return isPlainObject(value);
    case 'null':    return value === null;
    default:        return true;   // unknown type keyword -- pass through
  }
}

function typeOf(value: unknown): string {
  if (value === null) { return 'null'; }
  if (Array.isArray(value)) { return 'array'; }
  return typeof value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (typeof a !== typeof b) { return false; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) { return false; }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) { return false; }
    for (const k of ak) {
      if (!deepEqual(a[k], b[k])) { return false; }
    }
    return true;
  }
  return false;
}
