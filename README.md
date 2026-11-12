# JsonQL

Write your query language in JSON.

JsonQL is a small, dependency-free query engine for Node.js, modeled on GraphQL. A query is a plain JSON object that names the fields the client wants. JsonQL calls your resolvers and returns exactly those fields.

```js
{ "query": { "products": { "args": { "first": 2 }, "name": true, "owner": { "username": true } } } }
```

```json
{ "data": { "products": [{ "name": "mango", "owner": { "username": "ebuka" } }] } }
```

- No query parser and no string language: requests are JSON, so any HTTP client can build them.
- An optional schema checks requests and arguments and serializes output by type.
- GraphQL-style results: `{ data, errors }`, errors carry a `path`, and nulls propagate through non-null fields.
- Built-in HTTP handler for `node:http` and Express.
- Ships with TypeScript types. Requires Node.js 18 or later.

## Install

```sh
npm install jsonql
```

## Quick start

```js
const http = require("node:http");
const { createJsonQL, createHandler } = require("jsonql");

const engine = createJsonQL({
  schema: {
    Query: {
      products: { type: "[Product!]!", args: { first: { type: "Int", default: 10 } } },
    },
    Mutation: {
      createProduct: { type: "Product!", args: { name: "String!" } },
    },
    Product: { id: "ID!", name: "String!", owner: "Owner" },
    Owner: { username: "String!" },
  },
  resolvers: {
    Query: { products: (parent, { first }, context) => db.products.list(first) },
    Mutation: { createProduct: (parent, { name }, context) => db.products.create({ name }) },
    Product: { owner: (product, args, context) => db.users.get(product.ownerId) },
  },
});

// In process:
const result = await engine.execute({ query: { products: { name: true } } }, { user });

// Over HTTP:
http.createServer(createHandler(engine, { context: (req) => ({ user: auth(req) }) })).listen(4000);
```

Run `npm run example` for a working server based on `examples/products.js`.

## Writing requests

A request has exactly one top-level key: `query` or `mutation`.

| In a selection | Meaning |
| --- | --- |
| `"name": true` (or `1`, `"String"`, `String`) | Include this field. The value is only a marker. |
| `"name": false` / `null` | Leave the field out. Useful for building requests conditionally. |
| `"owner": { "username": true }` | Include an object field and choose its subfields. |
| `"args": { ... }` | Arguments for the field that contains them, at any level. |
| `"total": { "args": { "currency": "USD" } }` | Pass arguments to a scalar field. |

`args` is reserved and cannot be used as a field name. Field names must be valid JavaScript identifiers, and names that start with `__` (as well as `constructor` and `prototype`) are rejected.

Root fields of a `query` run concurrently. Root fields of a `mutation` run one after another, in the order written.

## Schema

The schema is optional. Each key is a type name, and each type maps field names to a type string or to `{ type, args }`:

```js
{
  Query:   { product: { type: "Product", args: { id: "ID!" } } },
  Product: { id: "ID!", name: "String!", tags: "[String!]", price: { type: "Float", args: { currency: { type: "String", default: "USD" } } } },
}
```

- **Built-in scalars:** `String`, `Int` (32-bit), `Float`, `Boolean`, `ID`, `JSON` (any value, not checked).
- **Modifiers:** `!` means non-null and `[T]` means a list.
- **Arguments** must have scalar types or lists of scalars, and can declare a `default`.
- `Query` is required. `Mutation` is optional.

With a schema:

- Requests are checked before any resolver runs. Unknown fields, missing or invalid arguments, subfields on scalars, and object fields with no selection are all reported together as `VALIDATION_FAILED` errors.
- Resolvers can be attached to any type: `resolvers.Product.owner(parent, args, context, info)`.
- Output is serialized by type. For example, `ID` becomes a string, `Date` values in `String` fields become ISO strings, and an `Int` field that returns `1.5` is an error.
- If a non-null field resolves to null or throws, the null moves up to the nearest nullable parent, as in GraphQL.
- `createJsonQL` throws at startup if a `Query` or `Mutation` field has no resolver, or if a resolver doesn't match any schema field.

Without a schema (`schema` omitted, `null`, or `{}`):

- Only `Query` and `Mutation` resolvers are allowed. Below the root, each field is read from the parent object.
- A field that isn't present resolves to `null`.
- If a property holds a function, it is called as `fn(args, context, info)`. Data objects can therefore expose computed fields or fields that take arguments.
- Selecting a plain object without choosing subfields is an error, so whole records can't leak by accident. Arrays of scalars and `Date`s can be selected as leaves.

## Resolvers

```js
(parent, args, context, info) => value | Promise<value>
```

`info` is `{ fieldName, parentType, returnType, operation, path }`. Nested promises are awaited, including promises inside arrays and inside resolved objects.

## Errors

The response is `{ data }`, `{ data, errors }` when some fields failed, or `{ errors }` when the request was invalid and nothing ran.

```json
{ "data": { "product": null }, "errors": [{ "message": "Not found", "path": ["product"], "extensions": { "code": "NOT_FOUND" } }] }
```

To send a deliberate error to the client, throw a `JsonQLError`:

```js
const { JsonQLError } = require("jsonql");
throw new JsonQLError("Not found", { code: "NOT_FOUND" });
```

In production, set `maskErrors: true`. Any other error is then sent as `"Internal server error"` (code `INTERNAL_ERROR`), and the original error is passed to `onError(err, { path })` for logging.

## API

### `createJsonQL(options) → engine`

| Option | Default | |
| --- | --- | --- |
| `resolvers` | (required) | `{ Query, Mutation, <Type> }` objects of functions |
| `schema` | none | Schema definition, or the result of `buildSchema()` |
| `maxDepth` | `15` | Maximum depth of nested selections |
| `maskErrors` | `false` | Hide the messages of unexpected errors |
| `onError` | none | `(err, { path }) => void`, called for every unexpected error |

`engine.execute(document, context?)` returns a promise that never rejects.

### `createHandler(engine, options?) → (req, res) => Promise<void>`

| Option | Default | |
| --- | --- | --- |
| `context` | `undefined` | A value, or `(req, res) => context` (may be async). Throw a `JsonQLError` with `status` (for example 401) to reject the request. |
| `maxBodySize` | 1 MiB | Larger bodies get a 413 response |
| `maskErrors`, `onError` | taken from the engine | |

The handler accepts `POST` with `Content-Type: application/json`. It responds with 200, 400 (invalid JSON or a request that failed validation), 405, 413, 415, or 500. If `req.body` was already parsed (for example by `express.json()`), it is used as-is:

```js
app.post("/jsonql", express.json(), createHandler(engine));
```

### `jsonql(schema, resolvers, document, context?) → Promise<result>`

Runs a single request without keeping an engine around. The schema is rebuilt on every call, so use `createJsonQL` in servers.

### `buildSchema(definition)`

Checks and normalizes a schema. It throws one error that lists every problem found. You can pass the result to `createJsonQL` to share a schema between engines.

## Limitations

These are not supported yet: aliases, fragments, input object types, custom scalars, enums, subscriptions, introspection, and batching or deduplicating resolver calls (DataLoader-style).

## Development

```sh
npm test                                       # run all tests
node --test test/schema.test.js                # run one file
node --test --test-name-pattern="maskErrors"   # run matching tests
npm run example                                # start the example server on :4000
```
