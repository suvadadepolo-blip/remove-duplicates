// Regenerates the agent files that are derived from other sources, so they
// cannot drift: the MCP server card (from the shared tool definition), the
// agent-skills index digest (from SKILL.md), and llms-full.txt (llms.txt plus
// every Markdown twin). `--check` fails instead of writing when a file is stale.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { REMOVE_DUPLICATES_TOOL } from "../public/js/agent-tool.js";
import { MCP_SERVER_INFO } from "../src/mcp.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ORIGIN = "https://removeduplicates.org";
const SKILL_PATH = "/.well-known/agent-skills/remove-duplicates/SKILL.md";
const MARKDOWN_PAGES = ["/index.md", "/excel.md", "/privacy.md", "/terms.md"];

const readPublic = (file) => readFile(path.join(root, "public", file), "utf8");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function buildAgentFiles() {
  const skill = await readPublic(SKILL_PATH);
  const skillDescription = skill.match(/^description: (.+)$/m)?.[1];
  const llms = await readPublic("/llms.txt");
  const pages = await Promise.all(MARKDOWN_PAGES.map(readPublic));

  return new Map([
    [
      "/.well-known/mcp/server-card.json",
      json({
        version: "1.0",
        protocolVersion: "2025-11-25",
        serverInfo: MCP_SERVER_INFO,
        description:
          "Stateless duplicate removal for text lists and CSV/TSV rows with the removeduplicates.org engine. Text is processed in memory for each call and never stored.",
        documentationUrl: `${ORIGIN}/llms.txt`,
        transport: { type: "streamable-http", endpoint: `${ORIGIN}/mcp` },
        endpoint: `${ORIGIN}/mcp`,
        authentication: { required: false, schemes: [] },
        capabilities: { tools: { listChanged: false } },
        tools: [
          {
            name: REMOVE_DUPLICATES_TOOL.name,
            title: REMOVE_DUPLICATES_TOOL.title,
            description: REMOVE_DUPLICATES_TOOL.description
          }
        ]
      })
    ],
    [
      "/.well-known/agent-skills/index.json",
      json({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "remove-duplicates",
            type: "skill-md",
            description: skillDescription,
            url: SKILL_PATH,
            digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`
          }
        ]
      })
    ],
    [
      "/llms-full.txt",
      [llms, ...pages, skill].map((part) => part.trimEnd()).join("\n\n---\n\n") + "\n"
    ]
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [file, contents] of await buildAgentFiles()) {
    const target = path.join(root, "public", file);
    const current = await readFile(target, "utf8").catch(() => null);
    if (current === contents) continue;
    if (check) stale.push(file);
    else await writeFile(target, contents);
  }
  if (stale.length > 0) {
    console.error(`Stale agent files (run node scripts/build-agent-files.mjs): ${stale.join(", ")}`);
    process.exit(1);
  }
}
