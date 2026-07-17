import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const target = process.env.OPENCLAW_TARGET_URL || process.env.OPENCLAW_PREVIEW_URL;
const artifactDir = process.env.OPENCLAW_ARTIFACT_DIR;
const runId = process.env.LIGHTHOUSE_RUN_ID?.trim();

if (!target) {
  throw new Error("OPENCLAW_TARGET_URL or OPENCLAW_PREVIEW_URL is required");
}

if (!artifactDir) {
  throw new Error("OPENCLAW_ARTIFACT_DIR is required");
}

mkdirSync(artifactDir, { recursive: true });

const pages = [
  ["home", new URL("/", target)],
  ["excel", new URL("/excel", target)]
];

const scoreTargets = {
  performance: 99,
  accessibility: 100,
  "best-practices": 100,
  seo: 100
};

const results = [];
let lighthouseVersion = "";

for (const [name, url] of pages) {
  if (runId) url.searchParams.set("lh", `${runId}-${name}`);

  const reportPath = join(artifactDir, `lighthouse-${name}.json`);
  const command = spawnSync(
    "npx",
    [
      "--no-install",
      "lighthouse",
      url.href,
      "--quiet",
      "--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage",
      "--only-categories=performance,accessibility,best-practices,seo",
      "--output=json",
      `--output-path=${reportPath}`
    ],
    { encoding: "utf8", timeout: 120_000 }
  );

  if (command.error) throw command.error;
  if (command.status !== 0) {
    throw new Error(
      `Lighthouse failed for ${name} (${command.status}): ${(command.stderr || command.stdout).trim()}`
    );
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  lighthouseVersion ||= report.lighthouseVersion;
  if (report.runtimeError) {
    throw new Error(`Lighthouse runtime error for ${name}: ${report.runtimeError.message}`);
  }

  const scores = Object.fromEntries(
    Object.keys(scoreTargets).map((category) => [
      category,
      Math.round((report.categories?.[category]?.score ?? 0) * 100)
    ])
  );

  for (const [category, minimum] of Object.entries(scoreTargets)) {
    if (scores[category] < minimum) {
      throw new Error(
        `${name} ${category} score ${scores[category]} is below the release target ${minimum}; report: ${reportPath}`
      );
    }
  }

  results.push({ name, url: url.href, scores, reportPath });
}

console.log(JSON.stringify({ ok: true, lighthouseVersion, results }));
