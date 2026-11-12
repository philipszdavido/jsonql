"use strict";

const { hasOwn, isPlainObject, formatPath } = require("./utils");
const { SCALARS, isNonNull, namedType } = require("./schema");
const { JsonQLError, formatError } = require("./errors");
const { parseDocument } = require("./validate");

// Thrown when a non-null field ends up null; the error itself is already recorded.
const BUBBLE = Symbol("jsonql.bubble");

/**
 * Runs a request document. Always resolves (never rejects) with
 * `{ data }`, `{ data, errors }`, or `{ errors }` when validation fails.
 */
async function execute({ schema, resolvers, document, context, maxDepth, maskErrors, onError }) {
  const errorOptions = { maskErrors, onError };
  const parsed = parseDocument(document, { schema, resolvers, maxDepth });
  if (parsed.errors) {
    return { errors: parsed.errors.map((err) => formatError(err, undefined, errorOptions)) };
  }

  const exe = {
    schema,
    resolvers,
    context,
    operation: parsed.operation,
    errors: [],
  };

  let data;
  try {
    data = await executeSelection(exe, parsed.rootTypeName, undefined, parsed.fields, [], parsed.operation === "mutation");
  } catch (err) {
    if (err !== BUBBLE) exe.errors.push({ err, path: [] });
    data = null;
  }

  const result = { data };
  if (exe.errors.length) {
    result.errors = exe.errors.map(({ err, path }) => formatError(err, path, errorOptions));
  }
  return result;
}

async function executeSelection(exe, typeName, parent, fields, path, serial) {
  const result = {};
  if (serial) {
    for (const field of fields) {
      result[field.name] = await executeField(exe, typeName, parent, field, path.concat(field.name));
    }
    return result;
  }

  const settled = await Promise.allSettled(
    fields.map((field) => executeField(exe, typeName, parent, field, path.concat(field.name)))
  );
  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") throw outcome.reason;
    result[fields[i].name] = outcome.value;
  });
  return result;
}

async function executeField(exe, parentTypeName, parent, field, path) {
  const type = field.def ? field.def.type : null;
  try {
    const value = await resolveFieldValue(exe, parentTypeName, parent, field, path);
    return await completeValue(exe, type, value, field, path);
  } catch (err) {
    if (err !== BUBBLE) exe.errors.push({ err, path });
    if (isNonNull(type)) throw BUBBLE;
    return null;
  }
}

function resolveFieldValue(exe, parentTypeName, parent, field, path) {
  const info = {
    fieldName: field.name,
    parentType: parentTypeName,
    returnType: field.def ? field.def.typeString : null,
    operation: exe.operation,
    path,
  };

  const typeResolvers = parentTypeName ? exe.resolvers[parentTypeName] : null;
  if (typeResolvers && hasOwn(typeResolvers, field.name)) {
    return typeResolvers[field.name](parent, field.args, exe.context, info);
  }
  return defaultResolve(parent, field, exe.context, info);
}

/**
 * Reads `parent[field]`. Methods are called as `(args, context, info)`, which
 * lets plain data objects expose computed or argument-taking fields. Members
 * inherited from Object.prototype (toString, hasOwnProperty, ...) are never
 * exposed.
 */
function defaultResolve(parent, field, context, info) {
  if (parent === null || parent === undefined || typeof parent !== "object") return undefined;
  const name = field.name;
  if (!hasOwn(parent, name) && name in Object.prototype) return undefined;
  const value = parent[name];
  return typeof value === "function" ? value.call(parent, field.args, context, info) : value;
}

async function completeValue(exe, type, value, field, path) {
  value = await value;

  if (type && type.kind === "NON_NULL") {
    const completed = await completeValue(exe, type.ofType, value, field, path);
    if (completed === null) {
      throw new JsonQLError(`Cannot return null for non-nullable field "${formatPath(path)}"`);
    }
    return completed;
  }

  if (value === null || value === undefined) return null;

  const isListType = type && type.kind === "LIST";
  if (Array.isArray(value)) {
    if (type && !isListType) {
      throw new Error(`Expected a single value for "${formatPath(path)}" (type ${field.def.typeString}) but resolver returned a list`);
    }
    return completeList(exe, isListType ? type.ofType : null, value, field, path);
  }
  if (isListType) {
    throw new Error(`Expected a list for "${formatPath(path)}" (type ${field.def.typeString}) but resolver returned ${typeof value}`);
  }

  if (type) {
    const name = namedType(type);
    if (hasOwn(SCALARS, name)) return SCALARS[name].serialize(value);
    if (typeof value !== "object") {
      throw new Error(`Expected an object for "${formatPath(path)}" (type ${name}) but resolver returned ${typeof value}`);
    }
    return executeSelection(exe, name, value, field.selection, path, false);
  }

  // Schemaless mode: the shape of the selection decides how to complete.
  if (field.selection) {
    if (typeof value !== "object") {
      throw new Error(`Cannot select subfields of "${formatPath(path)}": value is a ${typeof value}`);
    }
    return executeSelection(exe, null, value, field.selection, path, false);
  }
  return serializeLeaf(value, path);
}

async function completeList(exe, itemType, items, field, path) {
  const settled = await Promise.allSettled(
    items.map(async (item, i) => {
      const itemPath = path.concat(i);
      try {
        return await completeValue(exe, itemType, item, field, itemPath);
      } catch (err) {
        if (err !== BUBBLE) exe.errors.push({ err, path: itemPath });
        if (isNonNull(itemType)) throw BUBBLE;
        return null;
      }
    })
  );
  return settled.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}

function serializeLeaf(value, path) {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "object":
      if (value instanceof Date) return value.toISOString();
      if (isPlainObject(value)) {
        throw new Error(`Field "${formatPath(path)}" is an object; select the subfields you need`);
      }
      if (typeof value.toJSON === "function") return value.toJSON();
      throw new Error(`Field "${formatPath(path)}" is an object; select the subfields you need`);
    default:
      throw new Error(`Field "${formatPath(path)}" resolved to an unsupported ${typeof value} value`);
  }
}

module.exports = { execute };
