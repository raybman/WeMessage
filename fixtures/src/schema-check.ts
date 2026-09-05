/**
 * A test-only structural checker over the JSON Schema subset
 * `@wemessage/protocol` actually emits (§1.2). Written in s7 Scenario 2.
 *
 * Deliberately NOT ajv. `protocol-zero-runtime-deps` is a live
 * dependency-cruiser rule and F-54 stands: the schemas exist so a
 * stranger can validate our frames with THEIR validator, not so we can ship
 * one. What we owe ourselves is proof that the schemas say what we think they
 * say, and that is a ~100 line walk over six keywords.
 *
 * **Why it lives in `@wemessage/fixtures` and not in `packages/protocol/test`
 * (moved in s7 Scenario 3).** Sc 3 has to validate the bytes the daemon puts
 * on TWO wires against the same per-event schemas the protocol package pins,
 * and a daemon spec cannot import another package's `test/` directory: there
 * is no export map into it, and a relative climb out of one package into
 * another's test tree is the kind of edge that survives exactly until someone
 * runs one package's suite alone. `@wemessage/fixtures` is the repo's existing
 * test-support package — private, never shipped (§2.1), already a devDep of
 * every suite that needs it — so the checker moves there rather than being
 * copied. One checker, one behaviour, two callers. The alternative the
 * tooling notes allowed (duplicate it) would have put a hundred lines of
 * validator in two places and made a fix to one of them silently partial.
 *
 * `no-fixtures-in-prod-path` is untouched: no `packages/[asterisk]/src` imports this,
 * only `packages/protocol/test` and `packages/daemon/test`.
 *
 * Supported: `type` (object|array|string|number|integer|boolean|null),
 * `const`, `enum`, `required`, `additionalProperties: false`, `properties`,
 * `items`. An empty schema (`{}`) accepts anything, which is how the
 * nullable payload keys (`newText`, `value`, `until`) are spelled.
 *
 * Anything outside that subset is a hard error rather than a silent pass:
 * a checker that quietly ignores the keyword you were relying on is worse
 * than no checker, because it reports green.
 */
export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
}

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'required',
  'additionalProperties',
  'properties',
  'items',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'integer') {
    return actual === 'number' && Number.isInteger(value);
  }
  if (expected === 'number') return actual === 'number';
  return actual === expected;
}

/**
 * Returns the list of reasons `value` does not satisfy `schema`. Empty means
 * valid. A list rather than a boolean because a negative row that cannot say
 * WHY it refused is a negative row nobody can debug.
 */
export function schemaErrors(
  schema: JsonSchema,
  value: unknown,
  path = '$',
): string[] {
  const errors: string[] = [];

  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      errors.push(`${path}: unsupported schema keyword '${key}'`);
    }
  }

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected type ${schema.type}, got ${typeOf(value)}`);
    return errors; // every keyword below assumes the type held
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the enum`);
  }

  if (schema.properties !== undefined || schema.required !== undefined) {
    if (typeOf(value) !== 'object') {
      errors.push(`${path}: expected an object, got ${typeOf(value)}`);
      return errors;
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(`${path}: missing required key '${key}'`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, held] of Object.entries(record)) {
      const sub = properties[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}: additional key '${key}' is not permitted`);
        }
        continue;
      }
      errors.push(...schemaErrors(sub, held, `${path}.${key}`));
    }
  }

  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => {
      errors.push(
        ...schemaErrors(schema.items as JsonSchema, item, `${path}[${i}]`),
      );
    });
  }

  return errors;
}

/** Convenience for the positive rows: valid or a joined explanation. */
export function isValid(schema: JsonSchema, value: unknown): boolean {
  return schemaErrors(schema, value).length === 0;
}
