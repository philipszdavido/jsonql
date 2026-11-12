"use strict";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Names that would let a query reach into JavaScript internals.
const BLOCKED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isValidName(name) {
  return NAME_RE.test(name) && !BLOCKED_NAMES.has(name) && !name.startsWith("__");
}

function formatPath(path) {
  return path.reduce(
    (out, seg) => (typeof seg === "number" ? `${out}[${seg}]` : out ? `${out}.${seg}` : seg),
    ""
  );
}

module.exports = { hasOwn, isPlainObject, isValidName, formatPath };
