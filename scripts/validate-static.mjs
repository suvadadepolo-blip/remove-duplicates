import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (file) => readFile(path.join(root, file), "utf8");

const [
  index,
  excelIndex,
  terms,
  privacy,
  notFound,
  styles,
  excelStyles,
  app,
  excelApp,
  dedupe,
  tabular,
  dedupeWorker,
  excelWorker,
  workbookAdapter,
  xlsxPreflight,
  vendorModule,
  vendorLicense,
  vendorSource,
  vendorChecksums,
  manifestRaw,
  sitemap,
  robots,
  favicon,
  socialImage,
  socialImagePng,
  excelSocialImage,
  excelSocialImagePng,
  appleTouchIcon,
  manifestIcon,
  packageRaw,
  wranglerRaw,
  workerSource,
  browserQa,
  excelBrowserQa,
  fixtureGenerator,
  xlsxBenchmark,
  httpValidator,
  browserShell
] = await Promise.all([
  read("public/index.html"),
  read("public/excel/index.html"),
  read("public/terms/index.html"),
  read("public/privacy/index.html"),
  read("public/404.html"),
  read("public/styles.css"),
  read("public/excel.css"),
  read("public/js/app.js"),
  read("public/js/excel-app.js"),
  read("public/js/dedupe.js"),
  read("public/js/tabular.js"),
  read("public/js/dedupe-worker.js"),
  read("public/js/excel-worker.js"),
  read("public/js/workbook-adapter.js"),
  read("public/js/xlsx-preflight.js"),
  readFile(path.join(root, "public/vendor/sheetjs-0.20.3/xlsx.mjs")),
  read("public/vendor/sheetjs-0.20.3/LICENSE"),
  read("public/vendor/sheetjs-0.20.3/SOURCE.txt"),
  read("public/vendor/sheetjs-0.20.3/SHA256SUMS"),
  read("public/site.webmanifest"),
  read("public/sitemap.xml"),
  read("public/robots.txt"),
  read("public/favicon.svg"),
  read("public/og-image.svg"),
  readFile(path.join(root, "public/og-image.png")),
  read("public/og-image-excel.svg"),
  readFile(path.join(root, "public/og-image-excel.png")),
  readFile(path.join(root, "public/apple-touch-icon.png")),
  readFile(path.join(root, "public/icon-512.png")),
  read("package.json"),
  read("wrangler.jsonc"),
  read("src/worker.js"),
  read("scripts/openclaw-browser-qa.js"),
  read("scripts/openclaw-excel-browser-qa.js"),
  read("scripts/generate-xlsx-fixtures.mjs"),
  read("scripts/benchmark-xlsx.mjs"),
  read("scripts/validate-http.mjs"),
  read("scripts/openclaw-browser-validate.sh")
]);

const failures = [];
const passes = [];
const check = (condition, label) => {
  (condition ? passes : failures).push(label);
};

function joinedStringArrayConstant(source, name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\(\\s*["']{2}\\s*\\)`);
  const match = source.match(pattern);
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']*)["']/g)]
    .map((part) => part[1])
    .join("");
}

function inspectPng(buffer, background) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("invalid PNG signature");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`unsupported PNG layout: depth=${bitDepth} type=${colorType} interlace=${interlace}`);
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, up, upperLeft) => {
    const estimate = left + up - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
    return upDistance <= upperLeftDistance ? up : upperLeft;
  };

  for (let row = 0; row < height; row += 1) {
    const rawRow = row * (stride + 1);
    const outputRow = row * stride;
    const filter = raw[rawRow];
    for (let column = 0; column < stride; column += 1) {
      const source = raw[rawRow + 1 + column];
      const left = column >= bytesPerPixel ? pixels[outputRow + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[outputRow + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? pixels[outputRow + column - stride - bytesPerPixel]
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upperLeft)
                : NaN;
      if (!Number.isFinite(predictor)) throw new Error(`unsupported PNG filter: ${filter}`);
      pixels[outputRow + column] = (source + predictor) & 0xff;
    }
  }

  let inkPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += bytesPerPixel) {
    const alpha = bytesPerPixel === 4 ? pixels[offset + 3] : 255;
    if (alpha === 0) continue;
    const distance = Math.max(
      Math.abs(pixels[offset] - background[0]),
      Math.abs(pixels[offset + 1] - background[1]),
      Math.abs(pixels[offset + 2] - background[2])
    );
    if (distance > 12) inkPixels += 1;
  }
  return { width, height, inkShare: inkPixels / (width * height) };
}

const packageJson = JSON.parse(packageRaw);
const wrangler = JSON.parse(wranglerRaw);
const manifest = JSON.parse(manifestRaw);

check((index.match(/<h1\b/g) ?? []).length === 1, "home has exactly one h1");
check(/<title>[^<]*remove duplicates online/i.test(index), "title describes broad duplicate removal");
check(
  index.includes("<title>Remove Duplicates Online — Lines &amp; Text Lists</title>"),
  "home title leads with the generic remove-duplicates intent"
);
check(
  index.includes('name="description" content="Effortlessly remove duplicate lines from your text lists.'),
  "home description targets duplicate lines and text lists"
);
check(
  index.includes('property="og:title" content="Remove Duplicates Online — Lines &amp; Text Lists"') &&
    index.includes('name="twitter:title" content="Remove Duplicates Online — Lines &amp; Text Lists"'),
  "social titles mirror the homepage SEO positioning"
);
check(
  index.includes("<h1 id=\"page-title\">Remove duplicates from lines and lists.</h1>") &&
    index.includes("Effortlessly remove duplicate lines from your text lists."),
  "visible homepage copy mirrors the lines-and-lists search intent"
);
check(
  index.includes('name="description"') &&
    index.includes('rel="canonical" href="https://removeduplicates.org/"'),
  "home has description and canonical metadata"
);
check(
  /property="og:url" content="https:\/\/removeduplicates\.org\/"/.test(index) &&
    /property="og:image" content="https:\/\/removeduplicates\.org\/og-image\.png"/.test(index) &&
    index.includes('property="og:image:type" content="image/png"'),
  "Open Graph URLs use the canonical origin"
);
check(index.includes('href="/terms" data-legal-link="terms"'), "Terms keeps a real direct href");
check(index.includes('href="/privacy" data-legal-link="privacy"'), "Privacy keeps a real direct href");
check(index.includes("<dialog") && index.includes("data-legal-dialog"), "home uses a native legal dialog");
check(index.includes('id="dedupe-tool"'), "the focused tool has a stable in-page target");

check(index.includes("data-input"), "input text surface is static HTML");
check(index.includes("data-output"), "output text surface is static HTML");
check(index.includes("data-stats"), "live result statistics have a stable container");
check(index.includes("data-ignore-case"), "case-insensitive matching control is present");
check(index.includes("data-trim"), "trim control is present");
check(index.includes("data-remove-empty"), "empty-line removal control is present");
check(index.includes('name="format"') && index.includes("data-format-control"), "format control is present");
check(index.includes("data-table-options") && index.includes("data-compare") && index.includes("data-header"), "table controls are present");
check(index.includes("data-detected-format"), "table detection state has a stable hook");
check(/<button[^>]+data-undo/.test(index), "Clear Undo is a semantic button");
check(index.includes("data-shortcut-hint"), "platform shortcut hint has a stable hook");
check(
  /name="keep"[^>]*value="first"|value="first"[^>]*name="keep"/.test(index) &&
    /name="keep"[^>]*value="last"|value="last"[^>]*name="keep"/.test(index),
  "keep-first and keep-last controls are present"
);
check(
  /name="order"[^>]*value="preserve"|value="preserve"[^>]*name="order"/.test(index) &&
    /name="order"[^>]*value="sort"|value="sort"[^>]*name="order"/.test(index),
  "preserve-order and sorted-output controls are present"
);
for (const option of ["ignore-case", "trim", "remove-empty", "keep", "order"]) {
  check(index.includes(`data-option="${option}"`), `${option} has a semantic option hook`);
}
for (const action of ["process", "copy", "download", "clear", "sample"]) {
  check(
    index.includes(`data-${action}`) && index.includes(`data-action="${action}"`),
    `${action} action exposes stable behavior and semantic hooks`
  );
}
check(index.includes("data-drop-zone"), "local text-file drop zone is present");
check(/type="file"[^>]*accept="[^"]*\.csv[^"]*\.tsv[^"]*\.log[^"]*\.md[^"]*\.list/.test(index), "file input accepts supported plain-text formats");
check(index.includes('aria-live="polite"'), "home exposes a polite live result announcement");
check(/unique/i.test(index) && /duplicate/i.test(index), "initial HTML explains the live deduplication counts");
check(
  /browser/i.test(index) && /(?:never uploaded|not uploaded|does not upload|never leaves)/i.test(index),
  "home presents the local-processing trust boundary"
);

check(index.includes('type="application/ld+json"'), "structured data is present");
const jsonLd = index.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
const jsonLdCspHash = `sha256-${createHash("sha256").update(jsonLd ?? "").digest("base64")}`;
try {
  const parsed = JSON.parse(jsonLd);
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.["@graph"])
      ? parsed["@graph"]
      : [parsed];
  check(records.some((item) => item?.["@type"] === "WebApplication"), "structured data includes WebApplication");
  check(records.some((item) => item?.["@type"] === "FAQPage"), "structured data includes FAQPage");
  const webApplicationRecord = records.find((item) => item?.["@type"] === "WebApplication");
  check(
    webApplicationRecord?.name === "Remove Duplicates Online" &&
      webApplicationRecord?.alternateName === "RemoveDuplicates.org" &&
      webApplicationRecord?.description === "A free, private browser-based tool for removing duplicate lines and repeated entries from text lists.",
    "WebApplication structured data mirrors the homepage SEO positioning"
  );
  const faqRecord = records.find((item) => item?.["@type"] === "FAQPage");
  const schemaFaq = (faqRecord?.mainEntity ?? []).map((item) => [
    item?.name,
    item?.acceptedAnswer?.text
  ]);
  const visibleFaq = [...index.matchAll(/<details>\s*<summary>(.*?)<span[^>]*><\/span><\/summary>\s*<p>(.*?)<\/p>\s*<\/details>/gs)]
    .map((match) => [match[1].trim(), match[2].replace(/<[^>]+>/g, "").trim()]);
  check(JSON.stringify(schemaFaq) === JSON.stringify(visibleFaq), "visible FAQ exactly mirrors FAQ structured data");
} catch (error) {
  failures.push(`structured data parses: ${error.message}`);
}
check(/id="faq"/.test(index) && (index.match(/<details\b/g) ?? []).length >= 3, "FAQ schema has visible on-page answers");

check((excelIndex.match(/<h1\b/g) ?? []).length === 1, "Excel page has exactly one h1");
check(
  excelIndex.includes("<title>Remove Duplicates from Excel Online — Free XLSX Tool</title>"),
  "Excel title matches the approved search intent"
);
check(
  excelIndex.includes('name="description" content="Remove duplicate rows from an Excel file. Pick the columns that define duplicates and download a cleaned XLSX—free, private, entirely in your browser."'),
  "Excel description matches the approved copy"
);
check(
  excelIndex.includes('<link rel="canonical" href="https://removeduplicates.org/excel">') &&
    excelIndex.includes('<meta property="og:url" content="https://removeduplicates.org/excel">') &&
    excelIndex.includes('<meta property="og:image" content="https://removeduplicates.org/og-image-excel.png">'),
  "Excel canonical and Open Graph URLs use the canonical route"
);
check(
  excelIndex.includes('<h1 id="page-title">Remove duplicates from Excel files online.</h1>'),
  "Excel H1 matches the approved copy"
);
check(
  excelIndex.includes("Drop your XLSX file here") &&
    excelIndex.includes("Choose Excel file") &&
    excelIndex.includes("Download cleaned XLSX"),
  "Excel primary file and download actions are static HTML"
);
check(
  excelIndex.includes('href="/excel#excel-tool" data-excel-download'),
  "Excel download action has a crawlable static target before a Blob URL exists"
);
for (const hook of [
  "data-excel-sheet",
  "data-excel-header",
  "data-excel-columns",
  "data-excel-select-all",
  "data-excel-clear-columns",
  "data-excel-trim",
  "data-excel-ignore-case",
  "data-excel-remove-empty",
  "data-excel-confirm-warnings",
  "data-excel-process",
  "data-excel-result",
  "data-excel-download"
]) {
  check(excelIndex.includes(hook), `Excel page exposes ${hook}`);
}
check(
  /name="excel-keep"[^>]*value="first"|value="first"[^>]*name="excel-keep"/.test(excelIndex) &&
    /name="excel-keep"[^>]*value="last"|value="last"[^>]*name="excel-keep"/.test(excelIndex),
  "Excel page provides keep-first and keep-last controls"
);
check(
  excelIndex.includes("Hidden and filter-hidden rows are included") &&
    excelIndex.includes("Formula safety check active"),
  "Excel page discloses hidden-row and formula safety behavior"
);
check(
  excelIndex.includes("10 MiB compressed") &&
    excelIndex.includes("500,000 workbook cells") &&
    excelIndex.includes("250,000 cells in the selected sheet"),
  "Excel page advertises the tested limit contract"
);
check(
  excelIndex.includes('href="/terms" data-legal-link="terms"') &&
    excelIndex.includes('href="/privacy" data-legal-link="privacy"') &&
    excelIndex.includes("<dialog") &&
    excelIndex.includes("data-legal-dialog"),
  "Excel page keeps real legal links enhanced by a native dialog"
);

const excelJsonLd = excelIndex.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
const excelJsonLdCspHash = `sha256-${createHash("sha256").update(excelJsonLd ?? "").digest("base64")}`;
try {
  const parsed = JSON.parse(excelJsonLd);
  const records = Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];
  const application = records.find((item) => item?.["@type"] === "WebApplication");
  const faq = records.find((item) => item?.["@type"] === "FAQPage");
  check(
    application?.url === "https://removeduplicates.org/excel" &&
      application?.name === "Remove Duplicates from Excel Online" &&
      application?.featureList?.includes("Block unsafe formula and merged-row changes"),
    "Excel WebApplication schema mirrors shipped behavior"
  );
  const schemaFaq = (faq?.mainEntity ?? []).map((item) => [
    item?.name,
    item?.acceptedAnswer?.text
  ]);
  const visibleFaq = [...excelIndex.matchAll(/<details>\s*<summary>(.*?)<span[^>]*><\/span><\/summary>\s*<p>(.*?)<\/p>\s*<\/details>/gs)]
    .map((match) => [match[1].trim(), match[2].replace(/<[^>]+>/g, "").trim()]);
  check(schemaFaq.length === 6, "Excel FAQ schema contains six visible product answers");
  check(JSON.stringify(schemaFaq) === JSON.stringify(visibleFaq), "Excel visible FAQ exactly mirrors FAQ structured data");
} catch (error) {
  failures.push(`Excel structured data parses: ${error.message}`);
}
check(
  /id="excel-faq"/.test(excelIndex) && (excelIndex.match(/<details\b/g) ?? []).length === 6,
  "Excel FAQ schema has six visible answers"
);
check(
  index.includes('href="/excel"') && app.includes('href: "/excel"') && app.includes("setLinkedStatus"),
  "homepage links file and search guidance to the Excel tool"
);

for (const [label, html] of [["Terms", terms], ["Privacy", privacy]]) {
  check(html.includes('name="robots" content="noindex, nofollow"'), `${label} direct page is noindex`);
  check((html.match(/<h1\b/g) ?? []).length === 1, `${label} direct page has exactly one h1`);
  check(html.includes('href="/#dedupe-tool"'), `${label} direct page links back to the tool`);
  check(html.includes('rel="canonical"'), `${label} direct page declares its canonical URL`);
}
check(/browser/i.test(privacy) && /Cloudflare/i.test(privacy), "Privacy explains browser processing and Cloudflare delivery metadata");
check(/XLSX/i.test(privacy) && /Web Worker/i.test(privacy) && /download/i.test(privacy), "Privacy covers local workbook processing and downloads");
check(/XLSX/i.test(terms) && /formula/i.test(terms) && /Workbook warnings/i.test(terms), "Terms covers workbook safety and review responsibility");
check(notFound.includes('name="robots" content="noindex, nofollow"'), "404 is noindex");
check((notFound.match(/<h1\b/g) ?? []).length === 1, "404 has exactly one h1");

check(styles.includes("min-width: 320px"), "CSS declares a 320px support floor");
check(styles.includes("@media (prefers-reduced-motion: reduce)"), "CSS includes reduced-motion handling");
const copyMinWidthEm = Number(
  styles.match(/\[data-copy\][^{]*\{[^}]*min-width:\s*([\d.]+)em/s)?.[1]
);
check(copyMinWidthEm >= 6.5, "copy feedback reserves enough button width for its success label");
check(/@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.process-button kbd[\s\S]*?display: none/.test(styles), "touch-only devices hide the keyboard hint");
check(!/url\(["']?https?:/i.test(styles), "CSS has no external assets");
check(excelStyles.includes("@media (max-width: 520px)") && excelStyles.includes("@media (prefers-reduced-motion: reduce)"), "Excel CSS covers narrow and reduced-motion layouts");
check(!/url\(["']?https?:/i.test(excelStyles), "Excel CSS has no external assets");
check(!/<script[^>]+src=["']https?:/i.test(index), "home has no third-party script source");
check(!/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(index), "home has no third-party stylesheet");
check(!/<script[^>]+src=["']https?:/i.test(excelIndex), "Excel page has no third-party script source");
check(!/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(excelIndex), "Excel page has no third-party stylesheet");

const browserRuntime = `${app}\n${dedupe}\n${tabular}\n${dedupeWorker}`;
check(
  !/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/.test(browserRuntime),
  "browser runtime has no network or persistent-storage API"
);
check(app.includes("textContent") && !app.includes("innerHTML"), "user-facing rendering avoids innerHTML");
check(/history\.pushState/.test(app) && /addEventListener\(["']popstate["']/.test(app), "legal dialog participates in browser history");
check(/new\s+Worker\s*\(/.test(app), "large input has a Web Worker execution path");
check(/64\s*\*\s*1024|65536/.test(`${app}\n${dedupe}`), "large-input Worker handoff is explicit at 64 Ki characters");
check(app.includes('type: "chunk"') && dedupeWorker.includes('type === "chunk"'), "large text crosses the Worker boundary in event-loop-friendly chunks");
check(/10_?000|10000/.test(`${app}\n${dedupe}`), "large-input Worker threshold also considers 10,000 lines");
check(/5\s*\*\s*1024\s*\*\s*1024|5242880/.test(`${app}\n${dedupe}`), "local file and paste boundary is explicitly 5 MiB");
check(/navigator\.clipboard/.test(app), "copy action uses the browser clipboard API");
check(/new\s+Blob\s*\(/.test(app), "download action creates a local text blob");
check(/\.text\s*\(/.test(app), "local file content is read in the browser");
check(/onmessage|addEventListener\(["']message["']/.test(dedupeWorker), "dedupe Worker handles messages explicitly");
check(tabular.includes("JSON.stringify") === false && dedupe.includes("JSON.stringify"), "record compare keys are created in the dedupe layer");
check(dedupe.includes("selectedRecordCells") && dedupe.includes('.join(" ")'), "table sorting uses visible selected cell text");
check(dedupe.includes("selectSurvivorRows") && dedupe.includes("sourceCompare.slice()"), "shared survivor selection copies and canonicalizes multi-column comparisons");

const excelRuntime = `${excelApp}\n${excelWorker}\n${workbookAdapter}\n${xlsxPreflight}`;
check(
  !/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/.test(excelRuntime),
  "Excel runtime has no network or persistent-storage API"
);
check(!/\bconsole\s*\./.test(excelRuntime), "Excel runtime does not log workbook information");
check(excelApp.includes("textContent") && !excelApp.includes("innerHTML"), "Excel rendering avoids innerHTML");
check(/new\s+Worker\s*\(/.test(excelApp) && /type:\s*["']module["']/.test(excelApp), "Excel parsing uses a Module Worker");
check(
  excelApp.includes("inspectXlsxPackage(buffer)") &&
    excelApp.includes("[buffer]") &&
    !/\bXLSX\.(?:read|write)\b/.test(excelApp),
  "main thread preflights and transfers one buffer without parser fallback"
);
check(
  excelWorker.includes('type: "inspect"') ||
    (excelWorker.includes('data.type === "inspect"') && excelWorker.includes('data.type === "dedupe"')),
  "Excel Worker implements inspect and dedupe messages"
);
check(
  excelWorker.includes('data.type === "dispose"') &&
    excelWorker.includes('type: "inspected"') &&
    excelWorker.includes('type: "result"') &&
    excelWorker.includes('type: "error"'),
  "Excel Worker implements the complete response and dispose protocol"
);
check(
  excelWorker.includes('import("../vendor/sheetjs-0.20.3/xlsx.mjs")') &&
    !index.includes("sheetjs") &&
    !app.includes("sheetjs") &&
    !dedupe.includes("sheetjs"),
  "SheetJS is lazy-loaded only by the Excel Worker"
);
check(
  workbookAdapter.includes("selection.stats.removed === 0") &&
    workbookAdapter.includes("copyBuffer(originalBuffer)") &&
    workbookAdapter.includes('fail("formula_shift_unsafe")'),
  "adapter returns original bytes for zero removals and blocks formula row shifts"
);
check(
  workbookAdapter.includes('fail("merge_conflict")') &&
    workbookAdapter.includes('fail("warning_confirmation_required"'),
  "adapter blocks merge conflicts and enforces warning confirmation"
);
for (const code of [
  "unsupported_extension",
  "unsupported_format",
  "invalid_package",
  "encrypted",
  "compressed_limit",
  "zip_entry_limit",
  "zip_expanded_limit",
  "workbook_cell_limit",
  "sheet_cell_limit",
  "no_visible_sheet",
  "no_data_rows",
  "comparison_required",
  "missing_formula_cache",
  "merge_conflict",
  "formula_shift_unsafe",
  "warning_confirmation_required",
  "parser_unavailable",
  "worker_unavailable",
  "serialization_failed"
]) {
  check(excelRuntime.includes(code), `Excel runtime declares stable error code ${code}`);
}
check(
  /10\s*\*\s*1024\s*\*\s*1024/.test(xlsxPreflight) &&
    /2_000/.test(xlsxPreflight) &&
    /100\s*\*\s*1024\s*\*\s*1024/.test(xlsxPreflight) &&
    /50\s*\*\s*1024\s*\*\s*1024/.test(xlsxPreflight),
  "ZIP preflight fixes all four package limits"
);
check(
  xlsxPreflight.includes("ZIP64") &&
    xlsxPreflight.includes("Multi-volume") &&
    xlsxPreflight.includes("unsafe ZIP entry") &&
    xlsxPreflight.includes("Encrypted XLSX entries"),
  "ZIP preflight rejects ZIP64, multi-volume, unsafe paths, and encryption"
);

const vendorModuleHash = createHash("sha256").update(vendorModule).digest("hex");
const vendorLicenseHash = createHash("sha256").update(vendorLicense).digest("hex");
check(vendorModule.byteLength === 1_008_308, "pinned SheetJS ESM has the reviewed byte size");
check(vendorModule.toString("utf8").includes("XLSX.version = '0.20.3';"), "pinned SheetJS ESM declares version 0.20.3");
check(vendorLicense.includes("Apache License") && vendorLicense.length === 11_355, "SheetJS license is vendored intact");
check(
  vendorSource.includes("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs") &&
    vendorSource.includes("https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE"),
  "vendor source record points to official versioned URLs"
);
check(
  vendorChecksums.includes(`${vendorModuleHash}  xlsx.mjs`) &&
    vendorChecksums.includes(`${vendorLicenseHash}  LICENSE`),
  "vendor SHA256SUMS matches the vendored module and license"
);

const versionStamps = [
  index,
  excelIndex,
  terms,
  privacy,
  notFound,
  app,
  excelApp,
  dedupe,
  dedupeWorker,
  excelWorker,
  workbookAdapter
]
  .flatMap((source) => [...source.matchAll(/\?v=([0-9.]+)/g)].map((match) => match[1]));
check(versionStamps.length >= 15 && new Set(versionStamps).size === 1, "all CSS and JS version stamps are synchronized");

check(manifest.start_url === "/" && manifest.scope === "/", "manifest stays in apex scope");
check(
  /remove\s*duplicates/i.test(`${manifest.name ?? ""} ${manifest.short_name ?? ""}`),
  "manifest carries the product name"
);
check(manifest.icons?.some((icon) => icon.src === "/favicon.svg" && icon.sizes === "any"), "manifest includes the adaptive SVG icon");
check(manifest.icons?.some((icon) => icon.src === "/icon-512.png" && icon.sizes === "512x512" && icon.type === "image/png"), "manifest includes a 512px PNG icon");
check(favicon.includes("<svg") && socialImage.includes("<svg") && excelSocialImage.includes("<svg"), "favicon and both social images are valid local SVG assets");
check(index.includes('rel="apple-touch-icon" href="/apple-touch-icon.png"'), "home references the Apple touch icon");
for (const [label, buffer, dimensions, background] of [
  ["social PNG", socialImagePng, [1200, 630], [238, 241, 237]],
  ["Excel social PNG", excelSocialImagePng, [1200, 630], [238, 241, 237]],
  ["Apple touch icon", appleTouchIcon, [180, 180], [23, 35, 31]],
  ["manifest icon", manifestIcon, [512, 512], [23, 35, 31]]
]) {
  try {
    const inspected = inspectPng(buffer, background);
    check(
      inspected.width === dimensions[0] &&
        inspected.height === dimensions[1] &&
        inspected.inkShare >= 0.01,
      `${label} has exact dimensions and non-background ink`
    );
  } catch (error) {
    failures.push(`${label} decodes for pixel validation: ${error.message}`);
  }
}
check(
  sitemap.includes("<loc>https://removeduplicates.org/</loc>") &&
    sitemap.includes("<loc>https://removeduplicates.org/excel</loc>") &&
    (sitemap.match(/<loc>/g) ?? []).length === 2,
  "sitemap publishes exactly the canonical home and Excel routes"
);
check(robots.includes("Sitemap: https://removeduplicates.org/sitemap.xml"), "robots advertises the canonical sitemap");

check(wrangler.name === "removeduplicates-org", "Worker name is explicit");
check(wrangler.main === "src/worker.js", "Worker entry point is explicit");
check(wrangler.compatibility_date === "2026-07-14", "Worker compatibility date is pinned");
check(wrangler.workers_dev === true, "Workers.dev publishing is enabled");
check(
  wrangler.assets?.directory === "./public" &&
    wrangler.assets?.binding === "ASSETS" &&
    wrangler.assets?.run_worker_first === true &&
    wrangler.assets?.not_found_handling === "404-page" &&
    wrangler.assets?.html_handling === "none",
  "Worker Static Assets are configured with the proven worker-first contract"
);
check(
  wrangler.dev?.host === "127.0.0.1",
  "Wrangler dev keeps local preview requests on a loopback host"
);

const routes = wrangler.routes ?? [];
const expectedDomains = new Set(["removeduplicates.org", "www.removeduplicates.org"]);
const validFinalRoutes =
  routes.length === 2 &&
  routes.every(
    (route) => route.custom_domain === true && expectedDomains.has(route.pattern)
  ) &&
  new Set(routes.map((route) => route.pattern)).size === 2;
check(routes.length === 0 || validFinalRoutes, "custom domains are either absent for staging or exactly apex plus www");

check(!Object.hasOwn(packageJson, "dependencies") && !Object.hasOwn(packageJson, "devDependencies"), "project has no install-time dependencies");
check(packageJson.engines?.node === ">=22.12.0", "Node engine floor is explicit");
check(packageJson.scripts?.verify === "npm run check && npm test", "package exposes one reproducible verification command");
check(packageJson.scripts?.preview === "npx --yes wrangler@4.110.0 dev --ip 127.0.0.1 --port 3630", "preview pins Wrangler and managed port 3630");
check(packageJson.scripts?.deploy === "../bin/cf deploy --config wrangler.jsonc", "deployment uses the account-scoped wrapper");

check(workerSource.includes('const APEX_HOST = "removeduplicates.org"'), "Worker canonical host is explicit");
check(workerSource.includes(".workers.dev"), "Worker marks Workers.dev responses noindex");
check(workerSource.includes("status: 308"), "Worker owns the permanent www redirect");
check(
  workerSource.includes("function canonicalTargetFor") &&
    workerSource.includes('target.protocol = "https:"') &&
    workerSource.includes('target.pathname = "/excel"'),
  "Worker combines scheme, host, and Excel-path canonicalization in one target"
);
check(workerSource.includes("Strict-Transport-Security"), "Worker adds HSTS to HTTPS responses");
check(!workerSource.includes("unsafe-inline"), "Worker CSP does not allow arbitrary inline scripts");
check(
  joinedStringArrayConstant(workerSource, "HOME_JSON_LD_HASH") === jsonLdCspHash &&
    workerSource.includes("${HOME_JSON_LD_HASH}"),
  "Worker CSP pins the exact inline JSON-LD hash"
);
check(
  joinedStringArrayConstant(workerSource, "EXCEL_JSON_LD_HASH") === excelJsonLdCspHash &&
    workerSource.includes("${EXCEL_JSON_LD_HASH}"),
  "Worker CSP pins the exact Excel JSON-LD hash"
);
check(workerSource.includes('["/excel", "/excel/index.html"]'), "Worker explicitly maps the canonical Excel route");
check(
  workerSource.includes("sheetjs-0.20.3/xlsx.mjs") &&
    workerSource.includes("max-age=31536000, immutable"),
  "Worker gives the pinned SheetJS module immutable caching"
);
check(workerSource.includes('new URL("/404.html"'), "Worker owns the branded real-404 fallback");

const initialLoadFiles = [
  ["public/index.html", index],
  ["public/styles.css", styles],
  ["public/js/app.js", app],
  ["public/js/dedupe.js", dedupe],
  ["public/js/tabular.js", tabular]
];
const initialLoadBytes = initialLoadFiles.reduce(
  (sum, [, contents]) => sum + Buffer.byteLength(contents),
  0
);
const initialLoadBudgetBytes = 120 * 1024;
check(
  initialLoadBytes <= initialLoadBudgetBytes,
  `raw first-load HTML/CSS/JS is ${initialLoadBytes} bytes (budget ${initialLoadBudgetBytes}; conditional dedupe-worker excluded)`
);
check(Buffer.byteLength(dedupeWorker) <= 32 * 1024, "conditional large-input Worker stays below 32 KiB raw");

const excelInitialLoadFiles = [
  ["public/excel/index.html", excelIndex],
  ["public/styles.css", styles],
  ["public/excel.css", excelStyles],
  ["public/js/excel-app.js", excelApp],
  ["public/js/xlsx-preflight.js", xlsxPreflight]
];
const excelInitialLoadBytes = excelInitialLoadFiles.reduce(
  (sum, [, contents]) => sum + Buffer.byteLength(contents),
  0
);
const excelInitialLoadBudgetBytes = 200 * 1024;
check(
  excelInitialLoadBytes <= excelInitialLoadBudgetBytes,
  `raw Excel initial-load HTML/CSS/JS is ${excelInitialLoadBytes} bytes (budget ${excelInitialLoadBudgetBytes}; Worker and vendor excluded)`
);
check(
  Buffer.byteLength(excelWorker) + Buffer.byteLength(workbookAdapter) <= 64 * 1024,
  "conditional Excel Worker and adapter stay below 64 KiB raw"
);

for (const file of [
  "public/js/app.js",
  "public/js/dedupe.js",
  "public/js/tabular.js",
  "public/js/dedupe-worker.js",
  "public/js/excel-app.js",
  "public/js/excel-worker.js",
  "public/js/workbook-adapter.js",
  "public/js/xlsx-preflight.js",
  "public/vendor/sheetjs-0.20.3/xlsx.mjs",
  "src/worker.js",
  "scripts/openclaw-browser-qa.js",
  "scripts/openclaw-excel-browser-qa.js",
  "scripts/generate-xlsx-fixtures.mjs",
  "scripts/benchmark-xlsx.mjs",
  "scripts/validate-http.mjs",
  "scripts/validate-static.mjs"
]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    encoding: "utf8"
  });
  check(result.status === 0, `${file} passes node --check${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

const shell = spawnSync(
  "bash",
  ["-n", path.join(root, "scripts/openclaw-browser-validate.sh")],
  { encoding: "utf8" }
);
check(shell.status === 0, `browser validation shell passes bash -n${shell.stderr ? `: ${shell.stderr.trim()}` : ""}`);
check(browserQa.includes("1920") && browserQa.includes("1440") && browserQa.includes("1280") && browserQa.includes("390") && browserQa.includes("320"), "browser QA source names all five required viewport widths");
check(excelBrowserQa.includes("1920") && excelBrowserQa.includes("1440") && excelBrowserQa.includes("1280") && excelBrowserQa.includes("390") && excelBrowserQa.includes("320"), "Excel browser QA source names all five required viewport widths");
check(
  excelBrowserQa.includes("excel-basic.xlsx") &&
    excelBrowserQa.includes("excel-formula.xlsx") &&
    excelBrowserQa.includes("excel-merge-conflict.xlsx") &&
    excelBrowserQa.includes("createReadStream") &&
    excelBrowserQa.includes("parser failure stays in the Worker"),
  "Excel browser QA covers fixtures, downloaded-file readback, and parser failure"
);
check(
  fixtureGenerator.includes("RDQA_PRIVATE_MARKER_71f3") &&
    xlsxBenchmark.includes("500_000") &&
    xlsxBenchmark.includes("250_000") &&
    httpValidator.includes("http://www.removeduplicates.org/excel/"),
  "Excel fixtures, fixed benchmark tiers, privacy marker, and one-hop HTTP matrix are present"
);
check(
  browserShell.includes("@playwright/cli") &&
    browserShell.includes("openclaw-excel-browser-qa.js") &&
    browserShell.includes("OPENCLAW_TARGET_URL") &&
    browserShell.includes("OPENCLAW_PREVIEW_URL"),
  "browser QA exposes the approved OpenClaw target and Playwright CLI boundary"
);

if (failures.length > 0) {
  console.error(`Static validation failed (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Static validation passed (${passes.length} checks).`);
console.log(`Raw first-load HTML/CSS/JS: ${initialLoadBytes}/${initialLoadBudgetBytes} bytes.`);
console.log(`Raw Excel initial-load HTML/CSS/JS: ${excelInitialLoadBytes}/${excelInitialLoadBudgetBytes} bytes.`);
