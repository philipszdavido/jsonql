"use strict";

const http = require("node:http");
const { createHandler } = require("..");
const { engine } = require("./products");

const port = Number(process.env.PORT) || 4000;

const handler = createHandler(engine, {
  context: (req) => ({ requestId: req.headers["x-request-id"] }),
});

http.createServer(handler).listen(port, () => {
  console.log(`JsonQL server listening on http://localhost:${port}`);
  console.log(
    `Try: curl -s localhost:${port} -H 'Content-Type: application/json' ` +
      `-d '{"query":{"products":{"name":true,"owner":{"username":true}}}}'`
  );
});
