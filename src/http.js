"use strict";

const { JsonQLError, formatError } = require("./errors");

const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

/**
 * Creates a Node.js `(req, res)` handler that serves a JsonQL engine over HTTP.
 * Works with `http.createServer` and as Express/Connect middleware (a body
 * already parsed into `req.body` is used as-is).
 *
 * Request:  POST, Content-Type: application/json, body `{ "query": { ... } }`
 * Response: 200 with `{ data, errors? }`, or 4xx with `{ errors }`.
 */
function createHandler(engine, options = {}) {
  if (!engine || typeof engine.execute !== "function") {
    throw new TypeError("createHandler expects an engine created with createJsonQL()");
  }
  const { context, maxBodySize = DEFAULT_MAX_BODY_SIZE, maskErrors = engine.maskErrors, onError = engine.onError } = options;

  return async function jsonqlHandler(req, res) {
    try {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return send(res, 405, errorBody("Method not allowed; use POST"));
      }

      let body = req.body;
      if (body === undefined) {
        const contentType = String(req.headers["content-type"] || "");
        if (!/^application\/json\b/i.test(contentType)) {
          return send(res, 415, errorBody('Content-Type must be "application/json"'));
        }
        let raw;
        try {
          raw = await readBody(req, maxBodySize);
        } catch (err) {
          if (err.status === 413) return send(res, 413, errorBody(`Request body exceeds ${maxBodySize} bytes`));
          throw err;
        }
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, errorBody("Request body is not valid JSON"));
        }
      }

      let ctx;
      try {
        ctx = typeof context === "function" ? await context(req, res) : context;
      } catch (err) {
        const status = err instanceof JsonQLError ? err.status || 400 : 500;
        return send(res, status, { errors: [formatError(err, undefined, { maskErrors, onError })] });
      }

      const result = await engine.execute(body, ctx);
      return send(res, result.data === undefined ? 400 : 200, result);
    } catch (err) {
      return send(res, 500, { errors: [formatError(err, undefined, { maskErrors, onError })] });
    }
  };
}

function errorBody(message) {
  return { errors: [{ message }] };
}

function send(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = { createHandler };
