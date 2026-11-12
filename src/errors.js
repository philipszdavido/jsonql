"use strict";

/**
 * An error whose message is safe to show to API clients. Throw it from a
 * resolver (or a context factory) to send a deliberate, user-facing error.
 * Other errors are treated as unexpected and can be masked with `maskErrors`.
 */
class JsonQLError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, extensions?: object, path?: Array<string|number>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JsonQLError";
    this.extensions = { ...options.extensions };
    if (options.code) this.extensions.code = options.code;
    if (options.status) this.status = options.status;
    if (options.path) this.path = options.path;
  }
}

function validationError(message) {
  return new JsonQLError(message, { code: "VALIDATION_FAILED" });
}

/**
 * Converts any thrown value into the `{ message, path, extensions }` shape
 * returned to clients.
 */
function formatError(err, path, { maskErrors = false, onError } = {}) {
  const expected = err instanceof JsonQLError;
  if (!expected && typeof onError === "function") {
    try {
      onError(err, { path });
    } catch {
      // A failing logger must never break a response.
    }
  }

  let message;
  if (expected || !maskErrors) {
    message = err instanceof Error ? err.message : String(err);
  } else {
    message = "Internal server error";
  }

  const formatted = { message };
  if (path && path.length) formatted.path = path;
  if (expected) {
    if (Object.keys(err.extensions).length) formatted.extensions = err.extensions;
  } else if (maskErrors) {
    formatted.extensions = { code: "INTERNAL_ERROR" };
  }
  return formatted;
}

module.exports = { JsonQLError, validationError, formatError };
