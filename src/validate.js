"use strict";

const { hasOwn, isPlainObject, isValidName, formatPath } = require("./utils");
const { coerceInput, isNonNull, isScalarName, namedType } = require("./schema");
const { validationError } = require("./errors");

const OPERATIONS = { query: "Query", mutation: "Mutation" };

/**
 * Validates a request document and turns it into a list of field nodes:
 *   { name, args, selection: FieldNode[] | null, def }
 *
 * Returns `{ operation, rootType, fields }` or `{ errors }`.
 */
function parseDocument(document, { schema, resolvers, maxDepth }) {
  const errors = [];
  const fail = (message) => ({ errors: [validationError(message)] });

  if (!isPlainObject(document)) {
    return fail('Request must be an object with a "query" or "mutation" key');
  }

  const keys = Object.keys(document);
  const ops = keys.filter((k) => hasOwn(OPERATIONS, k));
  const unknown = keys.filter((k) => !hasOwn(OPERATIONS, k));
  if (ops.length !== 1) {
    return fail('Request must contain exactly one of "query" or "mutation"');
  }
  if (unknown.length) {
    return fail(`Unknown top-level key(s): ${unknown.map((k) => `"${k}"`).join(", ")}`);
  }

  const operation = ops[0];
  const rootTypeName = OPERATIONS[operation];
  const selection = document[operation];

  let rootType = null;
  if (schema) {
    rootType = schema.types[rootTypeName];
    if (!rootType) return fail(`This API does not support ${operation === "mutation" ? "mutations" : "queries"}`);
  }

  const ctx = { schema, resolvers, maxDepth, errors, rootTypeName };
  const fields = parseSelection(selection, rootType, [operation], 1, ctx, true);

  if (errors.length) return { errors: errors.map(validationError) };
  return { operation, rootTypeName, fields };
}

function parseSelection(selection, parentType, path, depth, ctx, isRoot) {
  const where = formatPath(path);
  if (!isPlainObject(selection)) {
    ctx.errors.push(`Selection at "${where}" must be an object`);
    return [];
  }

  const fields = [];
  for (const [name, value] of Object.entries(selection)) {
    if (name === "args") continue;
    if (value === false || value === null || value === undefined) continue;

    const fieldPath = path.concat(name);
    const fieldWhere = formatPath(fieldPath);

    if (!isValidName(name)) {
      ctx.errors.push(`Invalid field name "${name}" at "${where}"`);
      continue;
    }

    let def = null;
    if (ctx.schema) {
      def = hasOwn(parentType.fields, name) ? parentType.fields[name] : null;
      if (!def) {
        ctx.errors.push(`Unknown field "${name}" on type "${parentType.name}" at "${fieldWhere}"`);
        continue;
      }
    } else if (isRoot) {
      const rootResolvers = ctx.resolvers[ctx.rootTypeName];
      if (!rootResolvers || !hasOwn(rootResolvers, name)) {
        ctx.errors.push(`Unknown field "${name}" on type "${ctx.rootTypeName}" at "${fieldWhere}"`);
        continue;
      }
    }

    if (typeof value === "object" && !isPlainObject(value)) {
      ctx.errors.push(`Selection for "${fieldWhere}" must be an object or a leaf marker such as true`);
      continue;
    }

    const isObject = isPlainObject(value);
    const rawArgs = isObject ? value.args : undefined;
    const hasSubfields = isObject && Object.keys(value).some((k) => k !== "args");

    let args = {};
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      ctx.errors.push(`"args" of "${fieldWhere}" must be an object`);
    } else if (def) {
      args = coerceArgs(def, rawArgs || {}, fieldWhere, ctx.errors);
    } else if (rawArgs) {
      args = rawArgs;
    }

    let fieldSelection = null;
    const typeName = def ? namedType(def.type) : null;
    const isLeafType = def ? isScalarName(typeName) : null;

    if (hasSubfields) {
      if (isLeafType) {
        ctx.errors.push(`Field "${fieldWhere}" of type "${def.typeString}" cannot have subfields`);
        continue;
      }
      if (depth + 1 > ctx.maxDepth) {
        ctx.errors.push(`Query exceeds the maximum depth of ${ctx.maxDepth} at "${fieldWhere}"`);
        continue;
      }
      const childType = def ? ctx.schema.types[typeName] : null;
      const errorCount = ctx.errors.length;
      fieldSelection = parseSelection(value, childType, fieldPath, depth + 1, ctx, false);
      if (fieldSelection.length === 0 && ctx.errors.length === errorCount) {
        ctx.errors.push(`Field "${fieldWhere}" must select at least one subfield`);
        continue;
      }
    } else if (def && !isLeafType) {
      ctx.errors.push(`Field "${fieldWhere}" of type "${def.typeString}" must have a selection of subfields`);
      continue;
    }

    fields.push({ name, args, selection: fieldSelection, def });
  }
  return fields;
}

function coerceArgs(def, rawArgs, where, errors) {
  const args = {};
  for (const name of Object.keys(rawArgs)) {
    if (!hasOwn(def.args, name)) errors.push(`Unknown argument "${name}" on field "${where}"`);
  }
  for (const argDef of Object.values(def.args)) {
    const provided = hasOwn(rawArgs, argDef.name) && rawArgs[argDef.name] !== undefined;
    if (!provided) {
      if (argDef.default !== undefined) args[argDef.name] = argDef.default;
      else if (isNonNull(argDef.type)) {
        errors.push(`Missing required argument "${argDef.name}" of type "${argDef.typeString}" on field "${where}"`);
      }
      continue;
    }
    try {
      args[argDef.name] = coerceInput(argDef.type, rawArgs[argDef.name]);
    } catch (err) {
      errors.push(`Invalid value for argument "${argDef.name}" on field "${where}": ${err.message}`);
    }
  }
  return args;
}

module.exports = { parseDocument };
