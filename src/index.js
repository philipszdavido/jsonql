"use strict";

const { buildSchema } = require("./schema");
const { execute } = require("./execute");
const { createHandler } = require("./http");
const { JsonQLError } = require("./errors");
const { hasOwn, isPlainObject } = require("./utils");

const DEFAULT_MAX_DEPTH = 15;

/**
 * Creates a reusable engine. The schema is optional: without one, any field
 * can be selected and values are returned as resolved; with one, requests are
 * validated, arguments are type-checked, and output is serialized by type.
 *
 * @param {object} options
 * @param {object} [options.schema]    Type definitions (see README).
 * @param {object} options.resolvers   `{ Query: {...}, Mutation: {...}, <Type>: {...} }`
 * @param {number} [options.maxDepth]  Maximum selection nesting (default 15).
 * @param {boolean} [options.maskErrors] Hide messages of unexpected errors.
 * @param {(err: unknown, info: { path?: Array<string|number> }) => void} [options.onError]
 */
function createJsonQL(options = {}) {
  const { resolvers, maxDepth = DEFAULT_MAX_DEPTH, maskErrors = false, onError } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new TypeError("maxDepth must be a positive integer");
  if (onError !== undefined && typeof onError !== "function") throw new TypeError("onError must be a function");

  const schema = hasSchema(options.schema) ? buildSchema(options.schema) : null;
  checkResolvers(schema, resolvers);

  return {
    schema,
    maskErrors,
    onError,
    execute(document, context) {
      return execute({ schema, resolvers, document, context, maxDepth, maskErrors, onError });
    },
  };
}

/**
 * One-off execution, kept for compatibility with the original API.
 * Prefer `createJsonQL` so the schema is built and checked only once.
 */
function jsonql(schema, resolvers, document, context) {
  return createJsonQL({ schema, resolvers }).execute(document, context);
}

function hasSchema(schema) {
  return schema !== null && schema !== undefined && !(isPlainObject(schema) && Object.keys(schema).length === 0);
}

function checkResolvers(schema, resolvers) {
  if (!isPlainObject(resolvers)) throw new TypeError("resolvers must be an object");
  const problems = [];

  for (const [typeName, fields] of Object.entries(resolvers)) {
    if (!isPlainObject(fields)) {
      problems.push(`resolvers.${typeName} must be an object of functions`);
      continue;
    }
    if (!schema && typeName !== "Query" && typeName !== "Mutation") {
      problems.push(`resolvers.${typeName}: type resolvers require a schema; only Query and Mutation are allowed without one`);
      continue;
    }
    const type = schema ? schema.types[typeName] : null;
    if (schema && !type) {
      problems.push(`resolvers.${typeName}: type "${typeName}" is not defined in the schema`);
      continue;
    }
    for (const [fieldName, fn] of Object.entries(fields)) {
      if (typeof fn !== "function") problems.push(`resolvers.${typeName}.${fieldName} must be a function`);
      else if (type && !hasOwn(type.fields, fieldName)) {
        problems.push(`resolvers.${typeName}.${fieldName}: field is not defined in the schema`);
      }
    }
  }

  if (schema) {
    for (const root of [schema.query, schema.mutation]) {
      if (!root) continue;
      for (const field of Object.values(root.fields)) {
        const fn = resolvers[root.name] && resolvers[root.name][field.name];
        if (typeof fn !== "function") problems.push(`Missing resolver for ${root.name}.${field.name}`);
      }
    }
  }

  if (problems.length) throw new Error(`Invalid JsonQL resolvers:\n  - ${problems.join("\n  - ")}`);
}

module.exports = {
  createJsonQL,
  jsonql,
  buildSchema,
  createHandler,
  JsonQLError,
};
