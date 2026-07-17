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
    ]
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
