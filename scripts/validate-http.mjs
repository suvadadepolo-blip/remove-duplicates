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

async function request(url, options = {}) {
  return fetch(url, { redirect: "manual", ...options });
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
