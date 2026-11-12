"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createJsonQL, createHandler, JsonQLError } = require("..");

const engine = createJsonQL({
  resolvers: { Query: { whoami: (_p, _a, ctx) => ctx.user, boom: () => Promise.reject(new Error("secret")) } },
  maskErrors: true,
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (url, body, headers = { "content-type": "application/json" }) =>
  fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("serves queries with request context", async () => {
  const handler = createHandler(engine, { context: (req) => ({ user: req.headers["x-user"] }) });
  await withServer(handler, async (url) => {
    const res = await post(url, { query: { whoami: true } }, { "content-type": "application/json", "x-user": "ada" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await res.json(), { data: { whoami: "ada" } });
  });
});

test("returns 400 for validation errors and 200 with masked field errors", async () => {
  await withServer(createHandler(engine), async (url) => {
    const invalid = await post(url, { query: { nope: true } });
    assert.equal(invalid.status, 400);
    const failed = await post(url, { query: { boom: true } });
    assert.equal(failed.status, 200);
    assert.deepEqual((await failed.json()).errors[0].message, "Internal server error");
  });
});

test("rejects bad requests at the transport level", async () => {
  await withServer(createHandler(engine, { maxBodySize: 64 }), async (url) => {
    const get = await fetch(url);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
    assert.equal((await post(url, "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(url, "{not json")).status, 400);
    assert.equal((await post(url, { query: { whoami: true, pad: "x".repeat(100) } })).status, 413);
  });
});

test("context errors: JsonQLError status is honoured, others are 500", async () => {
  const denied = createHandler(engine, {
    context: () => {
      throw new JsonQLError("Unauthorized", { status: 401, code: "UNAUTHENTICATED" });
    },
  });
  await withServer(denied, async (url) => {
    const res = await post(url, { query: { whoami: true } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }] });
  });

  const broken = createHandler(engine, {
    context: () => {
      throw new Error("db down");
    },
  });
  await withServer(broken, async (url) => {
    const res = await post(url, { query: { whoami: true } });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).errors[0].message, "Internal server error");
  });
});

test("uses a body already parsed by middleware", async () => {
  const handler = createHandler(engine, { context: { user: "bob" } });
  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(payload) {
      this.body = JSON.parse(payload);
    },
  };
  await handler({ method: "POST", headers: {}, body: { query: { whoami: true } } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { data: { whoami: "bob" } });
});
