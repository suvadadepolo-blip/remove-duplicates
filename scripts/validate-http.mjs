import { createHash } from "node:crypto";

const mode = process.env.CHECK_MODE ?? "preview";
const previewOrigin = (process.env.OPENCLAW_TARGET_URL ?? process.env.OPENCLAW_PREVIEW_URL ?? "http://127.0.0.1:3630").replace(/\/$/, "");
const canonicalOrigin = mode === "production" ? "https://removeduplicates.org" : previewOrigin;
const cacheBust = mode === "production" ? `?rdqa=${Date.now()}` : "";
const expectedVendorHash = [
  "1a0fb062ee9781b13f668737",
  "1b202aaefc53b6ce55b530c0",
  "27e01f9c087b77db"
].join("");
const checks = [];

function record(condition, label, details = undefined) {
  checks.push({ label, pass: Boolean(condition), ...(details === undefined ? {} : { details }) });
}

// A network failure is recorded as a failed check so one unreachable host
// cannot hide the rest of the matrix.
async function request(url, options = {}) {
  try {
    return await fetch(url, { redirect: "manual", ...options });
  } catch (error) {
    record(false, `${options.method ?? "GET"} ${url} is reachable`, error.cause?.code ?? error.message);
    return new Response(null, { status: 599 });
  }
}

async function expectStatus(url, status, options = {}) {
  const response = await request(url, options);
  record(response.status === status, `${options.method ?? "GET"} ${url} -> ${status}`, response.status);
  return response;
}

const excel = await expectStatus(`${canonicalOrigin}/excel${cacheBust}`, 200);
record(excel.headers.get("content-type")?.includes("text/html"), "canonical Excel content type is HTML", excel.headers.get("content-type"));
record(excel.headers.get("content-security-policy")?.includes("script-src 'self'"), "canonical Excel CSP is present");

const head = await expectStatus(`${canonicalOrigin}/excel${cacheBust}`, 200, { method: "HEAD" });
record((await head.arrayBuffer()).byteLength === 0, "Excel HEAD response is bodyless");
const mutation = await expectStatus(`${canonicalOrigin}/excel${cacheBust}`, 405, { method: "POST" });
record(mutation.headers.get("allow") === "GET, HEAD", "Excel mutation response advertises GET and HEAD", mutation.headers.get("allow"));

for (const path of ["/EXCEL/?case=1", "/Excel?case=2", "/excel/?case=3"]) {
  const response = await expectStatus(`${canonicalOrigin}${path}`, 308);
  const expected = `${canonicalOrigin}/excel${path.includes("case=1") ? "?case=1" : path.includes("case=2") ? "?case=2" : "?case=3"}`;
  const relativeExpected = new URL(expected).pathname + new URL(expected).search;
  const location = response.headers.get("location");
  record(
    location === expected || (mode === "preview" && location === relativeExpected),
    `${path} canonicalizes in one hop`,
    location
  );
}

const vendor = await expectStatus(`${canonicalOrigin}/vendor/sheetjs-0.20.3/xlsx.mjs${cacheBust}`, 200);
const vendorBytes = Buffer.from(await vendor.arrayBuffer());
record(
  vendor.headers.get("cache-control")?.includes("immutable") && vendor.headers.get("cache-control")?.includes("31536000"),
  "pinned SheetJS uses long immutable caching",
  vendor.headers.get("cache-control")
);
record(createHash("sha256").update(vendorBytes).digest("hex") === expectedVendorHash, "served SheetJS fingerprint matches the vendored source");

const homepage = await expectStatus(`${canonicalOrigin}/${cacheBust}`, 200);
const homepageText = await homepage.text();
record(!homepageText.includes("sheetjs-0.20.3/xlsx.mjs"), "homepage HTML does not load the XLSX parser");
const sitemap = await expectStatus(`${canonicalOrigin}/sitemap.xml${cacheBust}`, 200);
const sitemapText = await sitemap.text();
record((sitemapText.match(/<loc>/g) ?? []).length === 2 && sitemapText.includes("https://removeduplicates.org/excel"), "sitemap contains exactly home and Excel routes");

// Agent and answer-engine surfaces.
record(homepage.headers.get("link")?.includes('rel="api-catalog"'), "homepage Link header advertises the API catalog", homepage.headers.get("link"));
record(homepage.headers.get("vary")?.includes("Accept"), "homepage varies on Accept", homepage.headers.get("vary"));

const markdownHome = await expectStatus(`${canonicalOrigin}/${cacheBust}`, 200, { headers: { Accept: "text/markdown" } });
record(markdownHome.headers.get("content-type")?.startsWith("text/markdown"), "Accept: text/markdown negotiates Markdown", markdownHome.headers.get("content-type"));
record((await markdownHome.text()).startsWith("# Remove duplicates"), "negotiated homepage Markdown carries the page heading");
const markdownExcel = await expectStatus(`${canonicalOrigin}/excel.md${cacheBust}`, 200);
record(markdownExcel.headers.get("link") === '<https://removeduplicates.org/excel>; rel="canonical"', "direct Markdown twin declares its canonical page", markdownExcel.headers.get("link"));

const robots = await expectStatus(`${canonicalOrigin}/robots.txt${cacheBust}`, 200);
record((await robots.text()).includes("Content-Signal: search=yes, ai-input=yes, ai-train=yes"), "robots.txt serves Content Signals");

const llms = await expectStatus(`${canonicalOrigin}/llms.txt${cacheBust}`, 200);
record(llms.headers.get("content-type") === "text/plain; charset=utf-8" && llms.headers.get("access-control-allow-origin") === "*", "llms.txt is plain text with open CORS", llms.headers.get("content-type"));
record((await llms.text()).startsWith("# RemoveDuplicates.org"), "llms.txt starts with the site H1");
await expectStatus(`${canonicalOrigin}/llms-full.txt${cacheBust}`, 200);
const llmAlias = await expectStatus(`${canonicalOrigin}/llm.txt`, 308);
record(llmAlias.headers.get("location") === "/llms.txt", "singular llm.txt redirects to llms.txt", llmAlias.headers.get("location"));

const apiCatalog = await expectStatus(`${canonicalOrigin}/.well-known/api-catalog${cacheBust}`, 200);
record(apiCatalog.headers.get("content-type") === "application/linkset+json", "API catalog uses application/linkset+json", apiCatalog.headers.get("content-type"));
record((await apiCatalog.json()).linkset?.[0]?.anchor === "https://removeduplicates.org/mcp", "API catalog anchors the MCP endpoint");
for (const file of ["/.well-known/ai-catalog.json", "/.well-known/mcp/server-card.json"]) {
  const response = await expectStatus(`${canonicalOrigin}${file}${cacheBust}`, 200);
  record(response.headers.get("access-control-allow-origin") === "*", `${file} allows cross-origin reads`);
  await response.json();
}
const skillsIndex = await (await expectStatus(`${canonicalOrigin}/.well-known/agent-skills/index.json${cacheBust}`, 200)).json();
const skill = skillsIndex.skills?.[0];
const skillBytes = Buffer.from(await (await expectStatus(`${canonicalOrigin}${skill?.url}${cacheBust}`, 200)).arrayBuffer());
record(skill?.digest === `sha256:${createHash("sha256").update(skillBytes).digest("hex")}`, "served SKILL.md matches its published sha256 digest", skill?.digest);

const mcp = async (message) =>
  request(`${canonicalOrigin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message })
  });
const initialize = await (await mcp({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rdqa", version: "1" } } })).json();
record(initialize.result?.protocolVersion === "2025-06-18" && initialize.result?.serverInfo?.name === "removeduplicates", "MCP initialize negotiates the requested protocol", initialize.result?.protocolVersion);
const toolList = await (await mcp({ method: "tools/list" })).json();
record(toolList.result?.tools?.map((tool) => tool.name).join() === "remove_duplicates", "MCP lists the remove_duplicates tool");
const toolCall = await mcp({ method: "tools/call", params: { name: "remove_duplicates", arguments: { text: "b\nA\na\nb", ignoreCase: true } } });
record(toolCall.headers.get("access-control-allow-origin") === "*", "MCP responses allow cross-origin clients");
const toolResult = (await toolCall.json()).result?.structuredContent;
record(toolResult?.text === "b\nA" && toolResult?.stats?.removed === 2, "MCP tool call returns the engine result", toolResult);
const mcpGet = await expectStatus(`${canonicalOrigin}/mcp`, 405);
record(mcpGet.headers.get("allow") === "POST, OPTIONS", "MCP GET advertises POST and OPTIONS", mcpGet.headers.get("allow"));

if (mode === "production") {
  const redirects = [
    ["http://removeduplicates.org/EXCEL/?edge=1", "https://removeduplicates.org/excel?edge=1"],
    ["https://www.removeduplicates.org/Excel/?edge=2", "https://removeduplicates.org/excel?edge=2"],
    ["http://www.removeduplicates.org/excel/?edge=3", "https://removeduplicates.org/excel?edge=3"]
  ];
  for (const [url, location] of redirects) {
    const response = await expectStatus(url, 308);
    record(response.headers.get("location") === location, `${url} combines scheme, host, and path in one hop`, response.headers.get("location"));
  }

  const workersDev = await expectStatus(`https://removeduplicates-org.whatmyname.workers.dev/excel?rdqa=${Date.now()}`, 200);
  record(workersDev.headers.get("x-robots-tag") === "noindex, nofollow", "Workers.dev Excel response is noindex", workersDev.headers.get("x-robots-tag"));
}

const failed = checks.filter(({ pass }) => !pass);
console.log(JSON.stringify({ mode, ok: failed.length === 0, checks, failed: failed.length }, null, 2));
if (failed.length > 0) process.exitCode = 1;
