"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createJsonQL, buildSchema } = require("..");

const schema = {
  Query: {
    products: { type: "[Product!]!", args: { first: { type: "Int", default: 10 }, tags: "[String!]" } },
    product: { type: "Product", args: { id: "ID!" } },
    count: "Int!",
  },
  Mutation: {
    createProduct: { type: "Product!", args: { name: "String!" } },
  },
  Product: {
    id: "ID!",
    name: "String!",
    price: "Float",
    owner: "Owner",
    related: { type: "[Product!]", args: { limit: "Int" } },
  },
  Owner: { username: "String!" },
};

const data = [
  { id: 1, name: "mango", price: 1.5, owner: { username: "ebuka" } },
  { id: 2, name: "kiwi", price: null, owner: null },
];

function makeEngine(overrides = {}) {
  return createJsonQL({
    schema,
    resolvers: {
      Query: {
        products: (_p, args) => data.slice(0, args.first),
        product: (_p, { id }) => data.find((p) => String(p.id) === id) || null,
        count: () => data.length,
        ...overrides.Query,
      },
      Mutation: { createProduct: (_p, { name }) => ({ id: 3, name }), ...overrides.Mutation },
      Product: { related: (parent, { limit = 1 }) => data.filter((p) => p !== parent).slice(0, limit) },
      ...overrides.types,
    },
  });
}

test.describe("buildSchema", () => {
  test("reports every problem at once", () => {
    assert.throws(
      () =>
        buildSchema({
          Query: { a: "Missing", b: "[Int", args: "String", c: { type: "Int", args: { x: "Owner" } } },
          Owner: { n: "String" },
          String: { x: "Int" },
        }),
      (err) =>
        /Unknown type "Missing"/.test(err.message) &&
        /Invalid type "\[Int"/.test(err.message) &&
        /"args" is reserved/.test(err.message) &&
        /must use a scalar type/.test(err.message) &&
        /conflicts with a built-in scalar/.test(err.message)
    );
  });

  test("requires a Query type", () => {
    assert.throws(() => buildSchema({ Product: { a: "Int" } }), /must define a "Query" type/);
  });

  test("validates argument defaults", () => {
    assert.throws(() => buildSchema({ Query: { a: { type: "Int", args: { n: { type: "Int", default: "x" } } } } }), /Invalid default/);
  });
});

test.describe("resolver checks at startup", () => {
  test("missing root resolvers and unknown resolver fields throw", () => {
    assert.throws(
      () => createJsonQL({ schema, resolvers: { Query: { products: () => [] }, Product: { nope: () => 1 }, Ghost: {} } }),
      (err) =>
        /Missing resolver for Query.product/.test(err.message) &&
        /Missing resolver for Mutation.createProduct/.test(err.message) &&
        /Product.nope: field is not defined/.test(err.message) &&
        /type "Ghost" is not defined/.test(err.message)
    );
  });
});

test.describe("schema mode execution", () => {
  test("resolves nested types, type resolvers, defaults and scalar serialization", async () => {
    const result = await makeEngine().execute({
      query: {
        products: { id: true, name: true, price: true, owner: { username: true }, related: { args: { limit: 1 }, name: true } },
        count: true,
      },
    });
    assert.deepEqual(result, {
      data: {
        products: [
          { id: "1", name: "mango", price: 1.5, owner: { username: "ebuka" }, related: [{ name: "kiwi" }] },
          { id: "2", name: "kiwi", price: null, owner: null, related: [{ name: "mango" }] },
        ],
        count: 2,
      },
    });
  });

  test("coerces ID args from integers", async () => {
    const result = await makeEngine().execute({ query: { product: { args: { id: 2 }, name: true } } });
    assert.deepEqual(result, { data: { product: { name: "kiwi" } } });
  });

  test("validation catches field, selection and argument mistakes together", async () => {
    const result = await makeEngine().execute({
      query: {
        products: { args: { first: "2", bogus: 1 }, nam: true, name: { x: true }, owner: true },
        product: { name: true },
      },
    });
    assert.equal(result.data, undefined);
    const messages = result.errors.map((e) => e.message);
    assert.deepEqual(messages, [
      'Unknown argument "bogus" on field "query.products"',
      'Invalid value for argument "first" on field "query.products": expected Int, got string "2"',
      'Unknown field "nam" on type "Product" at "query.products.nam"',
      'Field "query.products.name" of type "String!" cannot have subfields',
      'Field "query.products.owner" of type "Owner" must have a selection of subfields',
      'Missing required argument "id" of type "ID!" on field "query.product"',
    ]);
  });

  test("validates list arguments", async () => {
    const engine = makeEngine();
    const ok = await engine.execute({ query: { products: { args: { tags: ["a"] }, id: true } } });
    assert.equal(ok.errors, undefined);
    const bad = await engine.execute({ query: { products: { args: { tags: ["a", null] }, id: true } } });
    assert.match(bad.errors[0].message, /expected a non-null value/);
  });

  test("rejects mutations when the schema defines none", async () => {
    const engine = createJsonQL({ schema: { Query: { a: "Int" } }, resolvers: { Query: { a: () => 1 } } });
    const result = await engine.execute({ mutation: { a: true } });
    assert.match(result.errors[0].message, /does not support mutations/);
  });

  test("null in a non-null field bubbles to the nearest nullable parent", async () => {
    const engine = makeEngine({ Query: { product: () => ({ id: 1, name: null }) } });
    const result = await engine.execute({ query: { product: { args: { id: "1" }, id: true, name: true }, count: true } });
    assert.deepEqual(result, {
      data: { product: null, count: 2 },
      errors: [{ message: 'Cannot return null for non-nullable field "product.name"', path: ["product", "name"] }],
    });
  });

  test("a non-null root field failing nulls the whole response", async () => {
    const engine = makeEngine({
      Query: {
        count: () => {
          throw new Error("down");
        },
      },
    });
    const result = await engine.execute({ query: { count: true } });
    assert.deepEqual(result, { data: null, errors: [{ message: "down", path: ["count"] }] });
  });

  test("errors inside non-null list items null the list", async () => {
    const engine = makeEngine({ Query: { products: () => [{ id: 1, name: "a" }, { id: 2, name: null }] } });
    const result = await engine.execute({ query: { products: { name: true } } });
    assert.equal(result.data, null);
    assert.deepEqual(result.errors[0].path, ["products", 1, "name"]);
  });

  test("scalar output is type-checked", async () => {
    const engine = makeEngine({ Query: { count: () => 1.5 } });
    const result = await engine.execute({ query: { count: true } });
    assert.match(result.errors[0].message, /Int cannot represent number value 1.5/);
  });

  test("list/object shape mismatches are errors", async () => {
    const engine = makeEngine({ Query: { product: () => [data[0]] } });
    const result = await engine.execute({ query: { product: { args: { id: "1" }, name: true } } });
    assert.deepEqual(result.data, { product: null });
    assert.match(result.errors[0].message, /returned a list/);
  });

  test("mutations are validated against the schema", async () => {
    const engine = makeEngine();
    const ok = await engine.execute({ mutation: { createProduct: { args: { name: "fig" }, id: true, name: true } } });
    assert.deepEqual(ok, { data: { createProduct: { id: "3", name: "fig" } } });
    const missing = await engine.execute({ mutation: { createProduct: { id: true } } });
    assert.match(missing.errors[0].message, /Missing required argument "name"/);
  });
});
