import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.js";

function mockEnvironment({ missing = [] } = {}) {
  const seen = [];
  const files = new Map([
    ["/index.html", ["<h1>Remove Duplicate Lines</h1>", "text/html; charset=utf-8"]],
    ["/excel/index.html", ["<h1>Remove Duplicates from Excel</h1>", "text/html; charset=utf-8"]],
    ["/terms/index.html", ["<h1>Terms</h1>", "text/html; charset=utf-8"]],
    ["/privacy/index.html", ["<h1>Privacy</h1>", "text/html; charset=utf-8"]],
    ["/404.html", ["<h1>That line is missing</h1>", "text/html; charset=utf-8"]],
    ["/styles.css", ["body{}", "text/css; charset=utf-8"]],
    ["/js/app.js", ["export {};", "text/javascript; charset=utf-8"]],
    ["/js/module.mjs", ["export {};", "text/javascript; charset=utf-8"]],
    [
      "/vendor/sheetjs-0.20.3/xlsx.mjs",
      ["export const version = '0.20.3';", "text/javascript; charset=utf-8"]
    ],
    ["/index.md", ["# Remove duplicates from lines and lists", "text/markdown"]],
    ["/excel.md", ["# Remove duplicates from Excel files online", "text/markdown"]],
    ["/privacy.md", ["# Privacy", "text/markdown"]],
    ["/terms.md", ["# Terms", "text/markdown"]],
    ["/llms.txt", ["# RemoveDuplicates.org", "text/plain"]],
    ["/.well-known/api-catalog", ['{"linkset":[]}', "application/octet-stream"]],
    ["/.well-known/mcp/server-card.json", ["{}", "application/json"]]
  ]);

  return {
    seen,
    env: {
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          seen.push(url.pathname);
          if (missing.includes(url.pathname) || !files.has(url.pathname)) {
            return new Response(null, { status: 404 });
          }
          const [body, contentType] = files.get(url.pathname);
          return new Response(request.method === "HEAD" ? null : body, {
            status: 200,
            headers: { "Content-Type": contentType }
          });
        }
      }
    }
  };
}

test("redirects www to the canonical apex while preserving path and query", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://www.removeduplicates.org/privacy?source=footer&probe=1"),
    env
  );

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://removeduplicates.org/privacy?source=footer&probe=1"
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains"
  );
  assert.deepEqual(seen, []);
});

test("upgrades HTTP to HTTPS in one permanent hop while preserving path and query", async () => {
  const { env, seen } = mockEnvironment();
  const workersDev = await worker.fetch(
    new Request("http://removeduplicates-org.whatmyname.workers.dev/path?probe=1"),
    env
  );
  const www = await worker.fetch(
    new Request("http://www.removeduplicates.org/privacy?probe=1"),
    env
  );

  assert.equal(workersDev.status, 308);
  assert.equal(
    workersDev.headers.get("location"),
    "https://removeduplicates-org.whatmyname.workers.dev/path?probe=1"
  );
  assert.equal(workersDev.headers.get("strict-transport-security"), null);
  assert.equal(workersDev.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(www.status, 308);
  assert.equal(
    www.headers.get("location"),
    "https://removeduplicates.org/privacy?probe=1"
  );
  assert.deepEqual(seen, []);
});

test("canonicalizes Excel path variants together with scheme and host in one hop", async () => {
  const cases = [
    [
      "https://removeduplicates.org/excel/?source=nav&probe=1",
      "https://removeduplicates.org/excel?source=nav&probe=1"
    ],
    [
      "https://removeduplicates.org/ExCeL?source=mixed",
      "https://removeduplicates.org/excel?source=mixed"
    ],
    [
      "https://www.removeduplicates.org/EXCEL/?source=www",
      "https://removeduplicates.org/excel?source=www"
    ],
    [
      "http://www.removeduplicates.org/eXcEl/?source=combined",
      "https://removeduplicates.org/excel?source=combined"
    ],
    [
      "http://removeduplicates.org/Excel/?source=http",
      "https://removeduplicates.org/excel?source=http"
    ],
    [
      "https://removeduplicates-org.whatmyname.workers.dev/EXCEL/?source=staging",
      "https://removeduplicates-org.whatmyname.workers.dev/excel?source=staging"
    ],
    [
      "http://removeduplicates-org.whatmyname.workers.dev/Excel/?source=combined",
      "https://removeduplicates-org.whatmyname.workers.dev/excel?source=combined"
    ],
    [
      "http://127.0.0.1:3630/eXcEl/?source=preview",
      "/excel?source=preview"
    ]
  ];

  for (const [source, target] of cases) {
    const { env, seen } = mockEnvironment();
    const response = await worker.fetch(new Request(source), env);

    assert.equal(response.status, 308, source);
    assert.equal(response.headers.get("location"), target, source);
    assert.equal(response.headers.get("x-frame-options"), "DENY", source);
    assert.equal(
      response.headers.get("strict-transport-security"),
      source.startsWith("https:")
        ? "max-age=31536000; includeSubDomains"
        : null,
      source
    );
    assert.equal(
      response.headers.get("x-robots-tag"),
      new URL(source).hostname.endsWith(".workers.dev")
        ? "noindex, nofollow"
        : null,
      source
    );
    assert.equal(await response.text(), "", source);
    assert.deepEqual(seen, [], source);
  }
});

test("keeps loopback HTTP available for managed preview health checks", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(new Request("http://127.0.0.1:3630/"), env);

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/index.html"]);
  assert.equal(response.headers.get("strict-transport-security"), null);
});

test("serves direct legal routes with noindex and security headers", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/terms"),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/terms/index.html"]);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /worker-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /sha256-/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-inline/);
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains"
  );
  assert.equal(await response.text(), "<h1>Terms</h1>");
});

test("serves the homepage through the asset binding with revalidation", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/"),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/index.html"]);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, must-revalidate, no-transform"
  );
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  );
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.equal(await response.text(), "<h1>Remove Duplicate Lines</h1>");
});

test("serves the canonical Excel page through its explicit asset mapping", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/excel?source=direct"),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/excel/index.html"]);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, must-revalidate, no-transform"
  );
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.equal(await response.text(), "<h1>Remove Duplicates from Excel</h1>");
});

test("marks every workers.dev response noindex", async () => {
  const { env } = mockEnvironment();
  const root = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/"),
    env
  );
  const asset = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/styles.css"),
    env
  );
  const excel = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/excel"),
    env
  );
  const vendor = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/vendor/sheetjs-0.20.3/xlsx.mjs"),
    env
  );

  assert.equal(root.status, 200);
  assert.equal(root.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(excel.status, 200);
  assert.equal(excel.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("returns bodyless HEAD responses while preserving route headers", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/privacy", { method: "HEAD" }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/privacy/index.html"]);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(await response.text(), "");
});

test("serves a bodyless HEAD response for the canonical Excel route", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/excel", { method: "HEAD" }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/excel/index.html"]);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, must-revalidate, no-transform"
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(await response.text(), "");
});

test("serves ordinary JavaScript and module assets with revalidation caching", async () => {
  const { env, seen } = mockEnvironment();
  const script = await worker.fetch(
    new Request("https://removeduplicates.org/js/app.js"),
    env
  );
  const module = await worker.fetch(
    new Request("https://removeduplicates.org/js/module.mjs"),
    env
  );

  assert.equal(script.status, 200);
  assert.equal(module.status, 200);
  assert.deepEqual(seen, ["/js/app.js", "/js/module.mjs"]);
  assert.equal(
    script.headers.get("cache-control"),
    "public, max-age=0, must-revalidate"
  );
  assert.equal(
    module.headers.get("cache-control"),
    "public, max-age=0, must-revalidate"
  );
});

test("serves the pinned SheetJS module with immutable caching", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/vendor/sheetjs-0.20.3/xlsx.mjs"),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/vendor/sheetjs-0.20.3/xlsx.mjs"]);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable"
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("keeps a branded body and a real 404 status for unknown paths", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/missing"),
    env
  );

  assert.equal(response.status, 404);
  assert.deepEqual(seen, ["/missing", "/404.html"]);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await response.text(), /That line is missing/);
});

test("returns a bodyless branded 404 to HEAD requests", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/missing", { method: "HEAD" }),
    env
  );

  assert.equal(response.status, 404);
  assert.deepEqual(seen, ["/missing", "/404.html"]);
  assert.equal(await response.text(), "");
});

test("rejects mutation methods before reaching static assets", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/", {
      method: "POST"
    }),
    env
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepEqual(seen, []);
});

test("rejects mutation methods on the canonical Excel route with security headers", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/excel", { method: "POST" }),
    env
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains"
  );
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.deepEqual(seen, []);
});

const DISCOVERY_LINK_PREFIX =
  '</.well-known/api-catalog>; rel="api-catalog", </llms.txt>; rel="service-doc"; type="text/plain", ' +
  '</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"';

test("advertises agent discovery links and varies HTML routes on Accept", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/", {
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(
    response.headers.get("link"),
    `${DISCOVERY_LINK_PREFIX}, </index.md>; rel="alternate"; type="text/markdown"`
  );
  assert.equal(response.headers.get("vary"), "Accept");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(seen, ["/index.html"]);
});

test("negotiates the Markdown twin for agents that prefer text/markdown", async () => {
  const cases = [
    ["https://removeduplicates.org/", "text/markdown", "/index.md", null],
    ["https://removeduplicates.org/excel", "text/markdown, text/html;q=0.9", "/excel.md", null],
    ["https://removeduplicates.org/privacy", "text/markdown, */*", "/privacy.md", "noindex, nofollow"],
    ["https://removeduplicates.org/terms/", "text/markdown", "/terms.md", "noindex, nofollow"]
  ];

  for (const [source, accept, asset, robots] of cases) {
    const { env, seen } = mockEnvironment();
    const response = await worker.fetch(new Request(source, { headers: { Accept: accept } }), env);

    assert.equal(response.status, 200, source);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8", source);
    assert.equal(response.headers.get("vary"), "Accept", source);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=0, must-revalidate, no-transform",
      source
    );
    assert.equal(response.headers.get("x-robots-tag"), robots, source);
    assert.match(await response.text(), /^# /, source);
    assert.deepEqual(seen, [asset], source);
  }
});

test("keeps HTML when HTML ranks above Markdown or Markdown is refused", async () => {
  for (const accept of ["text/html, text/markdown;q=0.5", "text/markdown;q=0", "*/*", "text/plain"]) {
    const { env, seen } = mockEnvironment();
    const response = await worker.fetch(
      new Request("https://removeduplicates.org/excel", { headers: { Accept: accept } }),
      env
    );

    assert.match(response.headers.get("content-type"), /^text\/html/, accept);
    assert.deepEqual(seen, ["/excel/index.html"], accept);
  }
});

test("serves direct Markdown twins with a canonical link and CORS", async () => {
  const { env } = mockEnvironment();
  const response = await worker.fetch(new Request("https://removeduplicates.org/excel.md"), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("link"), '<https://removeduplicates.org/excel>; rel="canonical"');
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600, must-revalidate");
});

test("serves agent discovery files with explicit types and open CORS", async () => {
  const cases = [
    ["/llms.txt", "text/plain; charset=utf-8"],
    ["/.well-known/api-catalog", "application/linkset+json"],
    ["/.well-known/mcp/server-card.json", "application/json"]
  ];

  for (const [path, type] of cases) {
    const { env } = mockEnvironment();
    const response = await worker.fetch(new Request(`https://removeduplicates.org${path}`), env);

    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), type, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, follow", path);
  }

  const { env } = mockEnvironment();
  const staging = await worker.fetch(
    new Request("https://removeduplicates-org.whatmyname.workers.dev/llms.txt"),
    env
  );
  assert.equal(staging.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("does not dress a missing agent file up as a discovery response", async () => {
  const { env } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/.well-known/ai-catalog.json"),
    env
  );

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("redirects the singular llm.txt spellings to the llmstxt.org names", async () => {
  for (const [source, target] of [
    ["/llm.txt", "/llms.txt"],
    ["/llm-full.txt?probe=1", "/llms-full.txt?probe=1"]
  ]) {
    const { env, seen } = mockEnvironment();
    const response = await worker.fetch(new Request(`https://removeduplicates.org${source}`), env);

    assert.equal(response.status, 308, source);
    assert.equal(response.headers.get("location"), target, source);
    assert.deepEqual(seen, [], source);
  }
});

test("routes /mcp to the MCP handler before the GET/HEAD method gate", async () => {
  const { env, seen } = mockEnvironment();
  const response = await worker.fetch(
    new Request("https://removeduplicates.org/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(seen, []);

  const get = await worker.fetch(new Request("https://removeduplicates.org/mcp"), env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
});
