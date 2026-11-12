"use strict";

const { createJsonQL, JsonQLError } = require("..");

const products = [
  {
    id: 1,
    name: "mango",
    email: "er@example.com",
    number: 45,
    owner: { username: "ebuka", ownTags: { name: "ownTags1", id: 9 } },
    tags: [{ tagName: "fruits", tagObjs: { name: "tagObject 1", id: 90 } }],
  },
];

const schema = {
  Query: {
    products: { type: "[Product!]!", args: { first: { type: "Int", default: 10 } } },
    product: { type: "Product", args: { id: "ID!" } },
  },
  Mutation: {
    createProduct: { type: "Product!", args: { name: "String!", email: "String!" } },
  },
  Product: {
    id: "ID!",
    name: "String!",
    email: "String",
    number: "Int",
    owner: "Owner",
    tags: "[Tag!]",
  },
  Owner: { username: "String!", ownTags: "TagObject" },
  Tag: { tagName: "String!", tagObjs: "TagObject" },
  TagObject: { name: "String", id: "Int" },
};

const resolvers = {
  Query: {
    products: (_parent, { first }) => products.slice(0, first),
    product: (_parent, { id }) => products.find((p) => String(p.id) === id) || null,
  },
  Mutation: {
    createProduct: (_parent, { name, email }) => {
      if (products.some((p) => p.name === name)) {
        throw new JsonQLError(`A product named "${name}" already exists`, { code: "CONFLICT" });
      }
      const product = { id: products.length + 1, name, email, number: 100 };
      products.push(product);
      return product;
    },
  },
};

const engine = createJsonQL({ schema, resolvers });

module.exports = { engine, schema, resolvers };

if (require.main === module) {
  (async () => {
    const created = await engine.execute({
      mutation: { createProduct: { args: { name: "kiwi", email: "k@example.com" }, id: true, name: true } },
    });
    console.log(JSON.stringify(created));

    const listed = await engine.execute({
      query: {
        products: {
          args: { first: 2 },
          name: true,
          tags: { tagName: true },
          owner: { ownTags: { name: true } },
        },
      },
    });
    console.log(JSON.stringify(listed, null, 2));
  })();
}
