"use strict";

const { hasOwn, isPlainObject, isValidName } = require("./utils");

const BUILT = Symbol("jsonql.schema");

const isInt32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Built-in scalars. `serialize` converts resolver output, `parse` validates
 * argument input. Both throw on values they cannot represent.
 */
const SCALARS = {
  String: {
    serialize(v) {
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
      if (v instanceof Date) return v.toISOString();
      throw new TypeError(`String cannot represent ${describe(v)} value`);
    },
    parse(v) {
      if (typeof v === "string") return v;
      throw new TypeError(`expected String, got ${describe(v)}`);
    },
  },
  Int: {
    serialize(v) {
      if (isInt32(v)) return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      throw new TypeError(`Int cannot represent ${describe(v)} value ${JSON.stringify(v)}`);
    },
    parse(v) {
      if (isInt32(v)) return v;
      throw new TypeError(`expected Int, got ${describe(v)} ${JSON.stringify(v)}`);
    },
  },
  Float: {
    serialize(v) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      throw new TypeError(`Float cannot represent ${describe(v)} value`);
    },
    parse(v) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      throw new TypeError(`expected Float, got ${describe(v)}`);
    },
  },
  Boolean: {
    serialize(v) {
      if (typeof v === "boolean") return v;
      throw new TypeError(`Boolean cannot represent ${describe(v)} value`);
    },
    parse(v) {
      if (typeof v === "boolean") return v;
      throw new TypeError(`expected Boolean, got ${describe(v)}`);
    },
  },
  ID: {
    serialize(v) {
      if (typeof v === "string") return v;
      if (Number.isInteger(v) || typeof v === "bigint") return String(v);
      throw new TypeError(`ID cannot represent ${describe(v)} value`);
    },
    parse(v) {
      if (typeof v === "string") return v;
      if (Number.isInteger(v)) return String(v);
      throw new TypeError(`expected ID, got ${describe(v)}`);
    },
  },
  JSON: {
    serialize: (v) => v,
    parse: (v) => v,
  },
};

/**
 * Parses a type string such as "String", "Product!", or "[Tag!]!".
 */
function parseTypeRef(str, where) {
  if (typeof str !== "string") throw new Error(`Type at ${where} must be a string`);
  const s = str.trim();
  if (s.endsWith("!")) {
    const ofType = parseTypeRef(s.slice(0, -1), where);
    if (ofType.kind === "NON_NULL") throw new Error(`Invalid type "${str}" at ${where}`);
    return { kind: "NON_NULL", ofType };
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    return { kind: "LIST", ofType: parseTypeRef(s.slice(1, -1), where) };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { kind: "NAMED", name: s };
  throw new Error(`Invalid type "${str}" at ${where}`);
}

function namedType(type) {
  while (type.kind !== "NAMED") type = type.ofType;
  return type.name;
}

function typeToString(type) {
  if (type.kind === "NON_NULL") return `${typeToString(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeToString(type.ofType)}]`;
  return type.name;
}

const isNonNull = (type) => Boolean(type) && type.kind === "NON_NULL";

/**
 * Validates an argument value against its type and returns the coerced value.
 */
function coerceInput(type, value) {
  if (type.kind === "NON_NULL") {
    if (value === null || value === undefined) throw new TypeError("expected a non-null value");
    return coerceInput(type.ofType, value);
  }
  if (value === null) return null;
  if (type.kind === "LIST") {
    if (!Array.isArray(value)) throw new TypeError(`expected a list, got ${describe(value)}`);
    return value.map((item) => coerceInput(type.ofType, item));
  }
  return SCALARS[type.name].parse(value);
}

function normalizeArgs(rawArgs, where, errors) {
  const args = Object.create(null);
  if (rawArgs === undefined) return args;
  if (!isPlainObject(rawArgs)) {
    errors.push(`"args" of ${where} must be an object`);
    return args;
  }
  for (const [name, raw] of Object.entries(rawArgs)) {
    const argWhere = `${where}(${name})`;
    if (!isValidName(name)) {
      errors.push(`Invalid argument name at ${argWhere}`);
      continue;
    }
    const spec = typeof raw === "string" ? { type: raw } : raw;
    if (!isPlainObject(spec) || typeof spec.type !== "string") {
      errors.push(`Argument ${argWhere} must be a type string or { type, default }`);
      continue;
    }
    try {
      const type = parseTypeRef(spec.type, argWhere);
      const named = namedType(type);
      if (!hasOwn(SCALARS, named)) {
        errors.push(`Argument ${argWhere} must use a scalar type, got "${named}"`);
        continue;
      }
      const arg = { name, type, typeString: typeToString(type) };
      if (spec.default !== undefined) arg.default = coerceInput(type, spec.default);
      args[name] = arg;
    } catch (err) {
      errors.push(err.message.includes(argWhere) ? err.message : `Invalid default for ${argWhere}: ${err.message}`);
    }
  }
  return args;
}

/**
 * Turns a schema definition into the normalized form used by validation and
 * execution. Throws a single Error listing every problem found.
 *
 *   {
 *     Query:   { products: { type: "[Product!]!", args: { first: { type: "Int", default: 10 } } } },
 *     Product: { name: "String!", tags: "[String]" },
 *   }
 */
function buildSchema(definition) {
  if (definition && definition[BUILT]) return definition;
  if (!isPlainObject(definition)) throw new Error("Schema must be a plain object");

  const errors = [];
  const types = Object.create(null);

  for (const [typeName, fieldDefs] of Object.entries(definition)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeName) || typeName.startsWith("__")) {
      errors.push(`Invalid type name "${typeName}"`);
      continue;
    }
    if (hasOwn(SCALARS, typeName)) {
      errors.push(`Type "${typeName}" conflicts with a built-in scalar`);
      continue;
    }
    if (!isPlainObject(fieldDefs) || Object.keys(fieldDefs).length === 0) {
      errors.push(`Type "${typeName}" must be an object with at least one field`);
      continue;
    }

    const fields = Object.create(null);
    for (const [fieldName, raw] of Object.entries(fieldDefs)) {
      const where = `${typeName}.${fieldName}`;
      if (!isValidName(fieldName) || fieldName === "args") {
        errors.push(`Invalid field name at ${where}${fieldName === "args" ? ' ("args" is reserved)' : ""}`);
        continue;
      }
      const spec = typeof raw === "string" ? { type: raw } : raw;
      if (!isPlainObject(spec) || typeof spec.type !== "string") {
        errors.push(`Field ${where} must be a type string or { type, args }`);
        continue;
      }
      try {
        const type = parseTypeRef(spec.type, where);
        fields[fieldName] = {
          name: fieldName,
          type,
          typeString: typeToString(type),
          args: normalizeArgs(spec.args, where, errors),
        };
      } catch (err) {
        errors.push(err.message);
      }
    }
    types[typeName] = { name: typeName, fields };
  }

  if (!types.Query) errors.push('Schema must define a "Query" type');

  for (const type of Object.values(types)) {
    for (const field of Object.values(type.fields)) {
      const named = namedType(field.type);
      if (!hasOwn(SCALARS, named) && !types[named]) {
        errors.push(`Unknown type "${named}" referenced by ${type.name}.${field.name}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Invalid JsonQL schema:\n  - ${errors.join("\n  - ")}`);
  }

  return { [BUILT]: true, types, query: types.Query, mutation: types.Mutation || null };
}

const isScalarName = (name) => hasOwn(SCALARS, name);

module.exports = {
  SCALARS,
  buildSchema,
  parseTypeRef,
  namedType,
  typeToString,
  isNonNull,
  isScalarName,
  coerceInput,
};
