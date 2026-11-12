"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createJsonQL, jsonql, JsonQLError } = require("..");

const products = () => [
  {
    name: "mango",
    email: "er",
    number: 0,
    owner: { username: "ebuka", ownTags: { name: "t1", id: 9 } },
    tags: [{ tagName: "fruits" }, { tagName: "sweet" }],
  },
];

test.describe("schemaless mode", () => {
  test("projects only the selected fields, including falsy values", async () => {
    const result = await jsonql({}, { Query: { products } }, {
      query: { products: { name: String, number: Number, owner: { ownTags: { name: String } } } },
    });
    assert.deepEqual(result, {
      data: { products: [{ name: "mango", number: 0, owner: { ownTags: { name: "t1" } } }] },
    });
  });

  test("missing fields resolve to null", async () => {
    const result = await jsonql(null, { Query: { products } }, { query: { products: { nope: true } } });
    assert.deepEqual(result, { data: { products: [{ nope: null }] } });
  });

  test("false/null markers skip a field", async () => {
    const result = await jsonql(null, { Query: { products } }, { query: { products: { name: true, email: false } } });
    assert.deepEqual(result.data.products[0], { name: "mango" });
  });

  test("passes args to root resolvers, regardless of key order", async () => {
    let seen;
    const engine = createJsonQL({ resolvers: { Query: { item: (_p, args) => ((seen = args), { id: 1 }) } } });
    const result = await engine.execute({ query: { item: { id: true, args: { first: 2 } } } });
    assert.deepEqual(seen, { first: 2 });
    assert.deepEqual(result, { data: { item: { id: 1 } } });
  });

  test("calls methods on data objects with nested args and context", async () => {
    const engine = createJsonQL({
      resolvers: {
        Query: { user: () => ({ greet: (args, ctx) => `${ctx.greeting}, ${args.name}` }) },
      },
    });
    const result = await engine.execute(
      { query: { user: { greet: { args: { name: "Ada" } } } } },
      { greeting: "Hello" }
    );
    assert.deepEqual(result, { data: { user: { greet: "Hello, Ada" } } });
  });

  test("awaits async resolvers and promise-valued fields", async () => {
    const engine = createJsonQL({
      resolvers: { Query: { me: async () => ({ name: Promise.resolve("ada"), friends: [Promise.resolve({ name: "bob" })] }) } },
    });
    const result = await engine.execute({ query: { me: { name: true, friends: { name: true } } } });
    assert.deepEqual(result, { data: { me: { name: "ada", friends: [{ name: "bob" }] } } });
  });

  test("serializes Dates and arrays of scalars as leaves", async () => {
    const engine = createJsonQL({ resolvers: { Query: { x: () => ({ at: new Date(0), tags: ["a", "b"] }) } } });
    const result = await engine.execute({ query: { x: { at: true, tags: true } } });
    assert.deepEqual(result, { data: { x: { at: "1970-01-01T00:00:00.000Z", tags: ["a", "b"] } } });
  });

  test("refuses to return a whole object without a selection", async () => {
    const result = await jsonql(null, { Query: { products } }, { query: { products: { owner: true } } });
    assert.deepEqual(result.data, { products: [{ owner: null }] });
    assert.deepEqual(result.errors[0].path, ["products", 0, "owner"]);
    assert.match(result.errors[0].message, /select the subfields/);
  });

  test("never exposes Object.prototype members", async () => {
    const result = await jsonql(null, { Query: { products } }, {
      query: { products: { toString: true, hasOwnProperty: true, valueOf: true } },
    });
    assert.deepEqual(result, { data: { products: [{ toString: null, hasOwnProperty: null, valueOf: null }] } });
  });

  test("rejects unknown root fields", async () => {
    const result = await jsonql(null, { Query: { products } }, { query: { users: { name: true } } });
    assert.equal(result.data, undefined);
    assert.match(result.errors[0].message, /Unknown field "users" on type "Query"/);
  });

  test("rejects type resolvers without a schema", () => {
    assert.throws(() => createJsonQL({ resolvers: { Product: { name: () => "x" } } }), /require a schema/);
  });
});

test.describe("errors", () => {
  test("resolver errors become null with a path, siblings still resolve", async () => {
    const engine = createJsonQL({
      resolvers: {
        Query: {
          bad: () => {
            throw new Error("boom");
          },
          good: () => "ok",
        },
      },
    });
    const result = await engine.execute({ query: { bad: true, good: true } });
    assert.deepEqual(result, { data: { bad: null, good: "ok" }, errors: [{ message: "boom", path: ["bad"] }] });
  });

  test("maskErrors hides unexpected errors but keeps JsonQLError", async () => {
    const logged = [];
    const engine = createJsonQL({
      maskErrors: true,
      onError: (err) => logged.push(err.message),
      resolvers: {
        Query: {
          secret: () => {
            throw new Error("db password is hunter2");
          },
          known: () => {
            throw new JsonQLError("Not allowed", { code: "FORBIDDEN" });
          },
        },
      },
    });
    const result = await engine.execute({ query: { secret: true, known: true } });
    assert.deepEqual(result.errors, [
      { message: "Internal server error", path: ["secret"], extensions: { code: "INTERNAL_ERROR" } },
      { message: "Not allowed", path: ["known"], extensions: { code: "FORBIDDEN" } },
    ]);
    assert.deepEqual(logged, ["db password is hunter2"]);
  });

  test("validates the document envelope", async () => {
    const engine = createJsonQL({ resolvers: { Query: { a: () => 1 } } });
    for (const doc of [null, [], "x", {}, { query: {}, mutation: {} }, { query: { a: true }, extra: 1 }, { query: [] }]) {
      const result = await engine.execute(doc);
      assert.equal(result.data, undefined, JSON.stringify(doc));
      assert.equal(result.errors[0].extensions.code, "VALIDATION_FAILED");
    }
  });

  test("rejects dangerous field names", async () => {
    const engine = createJsonQL({ resolvers: { Query: { a: () => ({}) } } });
    const doc = JSON.parse('{"query":{"a":{"__proto__":{"x":true}}}}');
    const result = await engine.execute(doc);
    assert.match(result.errors[0].message, /Invalid field name "__proto__"/);
  });

  test("enforces maxDepth", async () => {
    const engine = createJsonQL({ maxDepth: 2, resolvers: { Query: { a: () => ({ b: { c: 1 } }) } } });
    assert.deepEqual(await engine.execute({ query: { a: { b: true } } }), { data: { a: { b: null } }, errors: [
      { message: 'Field "a.b" is an object; select the subfields you need', path: ["a", "b"] },
    ] });
    const tooDeep = await engine.execute({ query: { a: { b: { c: true } } } });
    assert.match(tooDeep.errors[0].message, /maximum depth of 2/);
  });
});

test.describe("mutations", () => {
  test("run root fields serially in order", async () => {
    const order = [];
    const delay = (ms, label) =>
      new Promise((resolve) => setTimeout(() => (order.push(label), resolve(label)), ms));
    const engine = createJsonQL({
      resolvers: { Mutation: { slow: () => delay(20, "slow"), fast: () => delay(1, "fast") } },
    });
    const result = await engine.execute({ mutation: { slow: true, fast: true } });
    assert.deepEqual(order, ["slow", "fast"]);
    assert.deepEqual(result, { data: { slow: "slow", fast: "fast" } });
  });

  test("run query root fields concurrently", async () => {
    const order = [];
    const delay = (ms, label) =>
      new Promise((resolve) => setTimeout(() => (order.push(label), resolve(label)), ms));
    const engine = createJsonQL({
      resolvers: { Query: { slow: () => delay(20, "slow"), fast: () => delay(1, "fast") } },
    });
    await engine.execute({ query: { slow: true, fast: true } });
    assert.deepEqual(order, ["fast", "slow"]);
  });
});
