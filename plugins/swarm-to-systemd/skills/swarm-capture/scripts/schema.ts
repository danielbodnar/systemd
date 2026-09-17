// SPDX-License-Identifier: LGPL-2.1-or-later
//
// A small JSON Schema validator covering the subset the inventory schema uses:
// type, required, properties, additionalProperties, items, enum, const,
// pattern, minimum, and local $ref into $defs. It exists so normalize.ts can
// validate against the published contract without a dependency.

export interface SchemaError {
  path: string;
  message: string;
}

type Schema = Record<string, any>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

export function validateSchema(value: unknown, schema: Schema, root: Schema = schema, path = "$", errors: SchemaError[] = []): SchemaError[] {
  if (schema.$ref) {
    const ref: string = schema.$ref;
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
    const target = ref.slice(2).split("/").reduce<any>((o, k) => (o ? o[k] : undefined), root);
    if (!target) throw new Error(`unresolved $ref ${ref}`);
    return validateSchema(value, target, root, path, errors);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `expected one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}` });
    return errors;
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` });
      return errors;
    }
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path, message: `does not match ${schema.pattern}` });
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `below minimum ${schema.minimum}` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateSchema(item, schema.items, root, `${path}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "required" });
    }
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) validateSchema(v, props[key], root, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: "unexpected property" });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchema(v, schema.additionalProperties, root, `${path}.${key}`, errors);
      }
    }
  }
  return errors;
}
