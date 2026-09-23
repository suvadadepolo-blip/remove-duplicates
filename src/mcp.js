import {
  AgentToolInputError,
  REMOVE_DUPLICATES_TOOL,
  REMOVE_DUPLICATES_TOOL_NAME,
  runRemoveDuplicates
} from "../public/js/agent-tool.js";

// Stateless MCP server (Streamable HTTP, JSON responses only) at /mcp.
// No session, no SSE stream, no storage, no logging: one JSON-RPC request in,
// one JSON answer out. Batches are refused so one request carries at most one
// bounded tool call.
export const MCP_PATH = "/mcp";
export const MCP_SERVER_INFO = Object.freeze({
  name: "removeduplicates",
  title: "RemoveDuplicates.org",
  version: "1.0.0"
});
const PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 512 * 1024;
const INSTRUCTIONS =
  "Removes duplicate lines or CSV/TSV rows with the removeduplicates.org engine. " +
  "Text is processed in memory for the call and never stored. " +
  "For .xlsx workbooks, send the user to https://removeduplicates.org/excel, which works only in their browser.";

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "Access-Control-Max-Age": "86400"
});

// Reads at most MAX_BODY_BYTES, so a chunked body without Content-Length is
// cut off instead of buffered whole. Returns null when the cap is exceeded.
async function readBoundedBody(request) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function callTool(id, params) {
  if (params?.name !== REMOVE_DUPLICATES_TOOL_NAME) {
    return rpcError(id, -32602, `Unknown tool: ${String(params?.name)}`);
  }
  try {
    const result = runRemoveDuplicates(params.arguments ?? {});
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false
    });
  } catch (error) {
    if (!(error instanceof AgentToolInputError)) throw error;
    return rpcResult(id, { content: [{ type: "text", text: error.message }], isError: true });
  }
}

function dispatch(message) {
  if (
    message === null ||
    typeof message !== "object" ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return rpcError(message?.id, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return null; // notification: nothing to answer
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [REMOVE_DUPLICATES_TOOL] });
    case "tools/call":
      return callTool(id, params);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request) {
  const headers = { ...CORS_HEADERS, "Cache-Control": "no-store" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") {
    return new Response(
      "This is a Model Context Protocol endpoint (Streamable HTTP). POST JSON-RPC requests here. Server card: https://removeduplicates.org/.well-known/mcp/server-card.json\n",
      {
        status: 405,
        headers: { ...headers, Allow: "POST, OPTIONS", "Content-Type": "text/plain; charset=utf-8" }
      }
    );
  }
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json" }
    });

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return json(rpcError(null, -32600, "Request too large"), 413);
  let bytes;
  try {
    bytes = await readBoundedBody(request);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (!bytes) return json(rpcError(null, -32600, "Request too large"), 413);
  let message;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(message)) {
    return json(rpcError(null, -32600, "Batch requests are not supported"), 400);
  }
  let answer;
  try {
    answer = dispatch(message);
  } catch {
    answer = rpcError(message?.id, -32603, "Internal error");
  }
  if (!answer) return new Response(null, { status: 202, headers });
  return json(answer, answer.error?.code === -32600 ? 400 : 200);
}
