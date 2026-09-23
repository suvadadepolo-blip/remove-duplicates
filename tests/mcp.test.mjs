import assert from "node:assert/strict";
import test from "node:test";

import { handleMcp } from "../src/mcp.js";
import { AGENT_TEXT_LIMIT_BYTES, runRemoveDuplicates } from "../public/js/agent-tool.js";
import { dedupeInput } from "../public/js/dedupe.js";

function post(body, headers = {}) {
  return new Request("https://removeduplicates.org/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function rpc(method, params, id = 1) {
  const response = await handleMcp(post({ jsonrpc: "2.0", id, method, params }));
  return { response, body: await response.json() };
}

const callTool = (args) => rpc("tools/call", { name: "remove_duplicates", arguments: args });

test("initialize echoes a supported protocol version and falls back to the newest", async () => {
  const known = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" }
  });
  assert.equal(known.response.status, 200);
  assert.equal(known.response.headers.get("content-type"), "application/json");
  assert.equal(known.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(known.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(known.body.result.serverInfo.name, "removeduplicates");
  assert.match(known.body.result.instructions, /never stored/);

  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.body.result.protocolVersion, "2025-11-25");
});

test("tools/list publishes one read-only tool with a strict input schema", async () => {
  const { body } = await rpc("tools/list", {});
  assert.equal(body.result.tools.length, 1);
  const [tool] = body.result.tools;
  assert.equal(tool.name, "remove_duplicates");
  assert.deepEqual(tool.inputSchema.required, ["text"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.outputSchema.type, "object");
});

test("tools/call removes duplicate lines with the website defaults", async () => {
  const { body } = await callTool({ text: "Orchid\nriver\n\nOrchid\nRiver" });
  assert.equal(body.result.isError, false);
  assert.deepEqual(body.result.structuredContent, {
    text: "Orchid\nriver\nRiver",
    format: { kind: "lines", columns: 1, header: false },
    stats: { total: 5, unique: 3, removed: 2, duplicates: 1, emptyRemoved: 1, reduction: 40 }
  });
  assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
});

test("tools/call applies every option exactly like the site engine", async () => {
  const text = "id,name\n2,Bob\n1,alice\n1,ALICE \n3,Bob";
  const options = {
    format: "table",
    ignoreCase: true,
    trim: true,
    removeEmpty: false,
    keep: "last",
    order: "sort",
    compare: [1],
    header: true
  };
  const { body } = await callTool({ text, ...options });
  const expected = dedupeInput(text, options);

  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.text, expected.text);
  assert.deepEqual(body.result.structuredContent.stats, expected.stats);
  assert.deepEqual(body.result.structuredContent.format, { kind: "csv", columns: 2, header: true });
});

test("tools/call reports fixable argument problems as tool errors", async () => {
  const cases = [
    [{}, /text is required/],
    [{ text: 7 }, /text is required/],
    [{ text: "a", colour: "red" }, /Unknown argument: colour/],
    [{ text: "a", keep: "middle" }, /keep must be/],
    [{ text: "a", ignoreCase: "yes" }, /ignoreCase must be a boolean/],
    [{ text: "a,b\nc,d", format: "table", compare: 5 }, /does not have/],
    [{ text: "x".repeat(AGENT_TEXT_LIMIT_BYTES + 1) }, /limit per call is 131072.*would miss duplicates/]
  ];
  for (const [args, message] of cases) {
    const { response, body } = await callTool(args);
    assert.equal(response.status, 200, JSON.stringify(args).slice(0, 60));
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, message);
  }
  assert.equal(runRemoveDuplicates({ text: "x".repeat(AGENT_TEXT_LIMIT_BYTES) }).stats.unique, 1);
});

test("unknown tools and methods are JSON-RPC errors", async () => {
  const tool = await rpc("tools/call", { name: "delete_everything", arguments: {} });
  assert.equal(tool.body.error.code, -32602);
  const method = await rpc("resources/list", {});
  assert.equal(method.body.error.code, -32601);
});

test("notifications are accepted without a body", async () => {
  const response = await handleMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("malformed, batched, and oversized requests are refused", async () => {
  const parse = await handleMcp(post("{not json"));
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);

  const invalid = await handleMcp(post({ id: 1, method: "ping" }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, -32600);

  const batch = await handleMcp(post([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
  assert.equal(batch.status, 400);
  assert.match((await batch.json()).error.message, /Batch/);

  const declared = await handleMcp(post("{}", { "Content-Length": String(600 * 1024) }));
  assert.equal(declared.status, 413);

  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  const streamed = await handleMcp(
    new Request("https://removeduplicates.org/mcp", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        pull(controller) {
          if (sent >= 16) return controller.close();
          sent += 1;
          controller.enqueue(chunk);
        }
      })
    })
  );
  assert.equal(streamed.status, 413);
  assert.ok(sent < 16, "reading stops once the cap is exceeded");
});

test("CORS preflight succeeds and other methods get a helpful 405", async () => {
  const preflight = await handleMcp(new Request("https://removeduplicates.org/mcp", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers"), /mcp-protocol-version/);

  const get = await handleMcp(new Request("https://removeduplicates.org/mcp"));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  assert.match(await get.text(), /server-card\.json/);
});
