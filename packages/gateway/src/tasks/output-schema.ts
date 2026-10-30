// A dependency-free JSON Schema subset for task outputs (ADR-0021 amendment 2). The Gateway only
// checks shapes; it never calls a model and never interprets the output. A schema may use `type`,
// `required`, `properties`, `enum`, `items` and `additionalProperties`, plus the annotations
// `title`, `description` and `$schema`. Any other keyword is refused when the schema is written,
// so an operator never stores a constraint (`minLength`, `pattern`, ...) that would go unchecked.
// No validator library: the subset is small, and a runtime dependency would be the Gateway's
// first schema engine for a check this narrow.
import { DeskmatesError, type TaskJson, type TaskOutputSchema } from "@deskmates/contracts";

export const OUTPUT_LIMITS = {
  /** Serialized size of a stored schema. */
  schemaBytes: 16_384,
  /** Serialized size of a delivered output. */
  outputBytes: 65_536,
  /** Nesting of subschemas (`properties`, `items`, `additionalProperties`). */
  depth: 16,
  /** Errors returned to the bot for one delivery; the last says how many were cut. */
  errors: 20,
} as const;

const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
type SchemaType = (typeof TYPES)[number];

const KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "enum",
  "items",
  "additionalProperties",
  "title",
  "description",
  "$schema",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DeskmatesError("validation", message);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function checkSchema(schema: unknown, at: string, depth: number): void {
  if (!isObject(schema)) fail(`${at} must be a JSON object`);
  if (depth > OUTPUT_LIMITS.depth)
    fail(`outputSchema is nested deeper than ${OUTPUT_LIMITS.depth} levels`);
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key))
      fail(
        `Unsupported outputSchema keyword ${key} at ${at}; supported: ${[...KEYWORDS].join(", ")}`,
      );
    switch (key) {
      case "type": {
        const list = Array.isArray(value) ? value : [value];
        if (
          list.length === 0 ||
          new Set(list).size !== list.length ||
          !list.every((t) => TYPES.includes(t as SchemaType))
        )
          fail(`${at}.type must be one of ${TYPES.join(", ")} or a non-empty list of them`);
        break;
      }
      case "required":
        if (
          !Array.isArray(value) ||
          !value.every((name) => typeof name === "string") ||
          new Set(value).size !== value.length
        )
          fail(`${at}.required must be a list of unique property names`);
        break;
      case "properties":
        if (!isObject(value)) fail(`${at}.properties must be an object of schemas`);
        for (const [name, sub] of Object.entries(value))
          checkSchema(sub, `${at}.properties.${name}`, depth + 1);
        break;
      case "enum":
        if (!Array.isArray(value) || value.length === 0)
          fail(`${at}.enum must be a non-empty list of values`);
        break;
      case "items":
        checkSchema(value, `${at}.items`, depth + 1);
        break;
      case "additionalProperties":
        if (typeof value !== "boolean") checkSchema(value, `${at}.additionalProperties`, depth + 1);
        break;
      default:
        // `title`, `description` and `$schema` are annotations: strings, never checked against.
        if (typeof value !== "string") fail(`${at}.${key} must be a string`);
    }
  }
}

/** Validates an operator-supplied schema at write time and returns it unchanged. */
export function parseOutputSchema(raw: unknown): TaskOutputSchema {
  if (!isObject(raw)) fail("outputSchema must be a JSON object");
  if (byteLength(raw) > OUTPUT_LIMITS.schemaBytes)
    fail(`outputSchema must be at most ${OUTPUT_LIMITS.schemaBytes} bytes of JSON`);
  checkSchema(raw, "outputSchema", 0);
  return raw as TaskOutputSchema;
}

/** A bot's delivered output: any JSON value within the size bound. */
export function parseOutput(raw: unknown): TaskJson {
  if (byteLength(raw) > OUTPUT_LIMITS.outputBytes)
    fail(`output must be at most ${OUTPUT_LIMITS.outputBytes} bytes of JSON`);
  // The value came from a parsed JSON body, so it is JSON already; the cast only names that.
  return raw as TaskJson;
}

function typeOf(value: unknown): SchemaType | "other" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object")
    return typeof value as SchemaType;
  return "other";
}

function matchesType(value: unknown, type: SchemaType): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/** Canonical JSON with sorted keys, so `enum` compares values rather than key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function check(schema: TaskOutputSchema, value: unknown, at: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as SchemaType[];
    if (!types.some((type) => matchesType(value, type))) {
      const got = typeOf(value);
      errors.push(
        `${at}: expected ${types.join(" or ")}, got ${got === "integer" ? "number" : got}`,
      );
      return;
    }
  }
  if (Array.isArray(schema.enum)) {
    const wanted = canonical(value);
    if (!schema.enum.some((option) => canonical(option) === wanted))
      errors.push(`${at}: must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required))
      for (const name of schema.required)
        if (typeof name === "string" && !(name in value))
          errors.push(`${at}: missing required property ${name}`);
    for (const [name, sub] of Object.entries(properties))
      if (name in value && isObject(sub))
        check(sub as TaskOutputSchema, value[name], `${at}.${name}`, errors);
    const extra = schema.additionalProperties;
    for (const name of Object.keys(value)) {
      if (name in properties) continue;
      if (extra === false) errors.push(`${at}: unexpected property ${name}`);
      else if (isObject(extra))
        check(extra as TaskOutputSchema, value[name], `${at}.${name}`, errors);
    }
  }
  if (Array.isArray(value) && isObject(schema.items))
    value.forEach((item, i) =>
      check(schema.items as TaskOutputSchema, item, `${at}[${i}]`, errors),
    );
}

/**
 * Every way `value` breaks `schema`, as readable lines with a path rooted at `output`. An empty
 * list means it conforms. At most `OUTPUT_LIMITS.errors` lines; the last says how many were cut.
 */
export function outputErrors(schema: TaskOutputSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, "output", errors);
  if (errors.length <= OUTPUT_LIMITS.errors) return errors;
  const shown = errors.slice(0, OUTPUT_LIMITS.errors - 1);
  shown.push(`${errors.length - shown.length} more errors not shown`);
  return shown;
}

/**
 * A validated illustrative value, or undefined when the supported constraints cannot be
 * satisfied. Never send a correction example that the same validator would reject.
 */
export function exampleOutput(schema: TaskOutputSchema, depth = 0): TaskJson | undefined {
  if (depth > OUTPUT_LIMITS.depth) return undefined;
  if (Array.isArray(schema.enum))
    return schema.enum.find((value) => outputErrors(schema, value).length === 0) as
      | TaskJson
      | undefined;
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const items = isObject(schema.items) ? (schema.items as TaskOutputSchema) : undefined;
  const types =
    schema.type === undefined
      ? [properties || schema.required ? "object" : items ? "array" : "string", "null"]
      : Array.isArray(schema.type)
        ? schema.type
        : [schema.type];
  for (const type of types) {
    let value: TaskJson | undefined;
    switch (type) {
      case "object": {
        const required = new Set(
          Array.isArray(schema.required) ? (schema.required as string[]) : [],
        );
        const object: { [key: string]: TaskJson } = {};
        let possible = true;
        for (const name of required.size > 0 ? required : Object.keys(properties ?? {})) {
          const sub = properties?.[name] ?? schema.additionalProperties;
          const child = isObject(sub)
            ? exampleOutput(sub as TaskOutputSchema, depth + 1)
            : sub === false
              ? undefined
              : "<value>";
          if (child !== undefined)
            Object.defineProperty(object, name, {
              value: child,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          else if (required.has(name)) possible = false;
        }
        if (possible) value = object;
        break;
      }
      case "array": {
        const item = items ? exampleOutput(items, depth + 1) : undefined;
        value = item === undefined ? [] : [item];
        break;
      }
      case "string":
        value = "<text>";
        break;
      case "number":
      case "integer":
        value = 0;
        break;
      case "boolean":
        value = true;
        break;
      case "null":
        value = null;
        break;
    }
    if (value !== undefined && outputErrors(schema, value).length === 0) return value;
  }
  return undefined;
}
