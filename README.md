# removeduplicates.org

A focused static tool for removing duplicates from lines, lists, pasted spreadsheet data, CSV files, and local XLSX workbooks, deployed as a Cloudflare Worker with Static Assets.

Links:

- Website: [RemoveDuplicates.org](https://removeduplicates.org/)
- Excel tool: [Remove duplicates from Excel online](https://removeduplicates.org/excel)
- Source code: [describesomeone/remove-duplicates](https://github.com/describesomeone/remove-duplicates)

License: MIT

## Product boundary

- Line and table-aware deduplication runs in browser memory; larger inputs are streamed to a same-origin Web Worker in responsive chunks.
- Excel and Google Sheets rows can be pasted as TSV, while quoted CSV/TSV files can be opened up to the same 5 MB local limit.
- [The Excel tool](https://removeduplicates.org/excel) accepts only macro-free `.xlsx` files, compares an entire row or a stable combination of selected columns, and creates the cleaned workbook in a dedicated Module Worker.
- XLSX package limits are 10 MiB compressed, 2,000 ZIP entries, 100 MiB declared expanded data, 500,000 workbook cells, and 250,000 cells in the selected sheet. Formula row shifts and intersecting merged ranges are blocked.
- SheetJS CE 0.20.3 is pinned under `public/vendor/sheetjs-0.20.3/` with its official source URLs, license, and SHA-256 receipt. It is lazy-loaded only after a valid XLSX passes local ZIP preflight and is never requested by the homepage.
- The website does not upload or persist text or workbook contents a user opens. The only server-side processing is the optional `/mcp` endpoint, which handles text an AI agent sends for that one request and stores nothing.
- No account, database, analytics, advertising, external font, or third-party browser runtime is included.
- Cloudflare still processes ordinary HTTP metadata needed to deliver and protect the site; the Privacy copy states this boundary directly.
- Terms and Privacy are real direct pages, enhanced into an in-page dialog when JavaScript is available.

## Agent and answer-engine surfaces

- `robots.txt` names the major AI crawlers and declares `Content-Signal: search=yes, ai-input=yes, ai-train=yes`.
- `/llms.txt` and `/llms-full.txt` (with `/llm.txt` redirects) describe the site for language models.
- Every page has a Markdown twin (`/index.md`, `/excel.md`, `/privacy.md`, `/terms.md`), also served for `Accept: text/markdown`. HTML routes send `Vary: Accept` and RFC 8288 `Link` headers for the API catalog, `llms.txt`, the agent-skills index, and the Markdown alternate.
- `/.well-known/api-catalog` (RFC 9727), `/.well-known/mcp/server-card.json`, `/.well-known/agent-skills/index.json` with `remove-duplicates/SKILL.md`, and `/.well-known/ai-catalog.json`.
- `/mcp` is a stateless Streamable HTTP MCP server with one tool, `remove_duplicates`, capped at 128 KiB of text per call. The homepage registers the same tool through WebMCP when the browser exposes `navigator.modelContext`; that path runs locally in the tab. Both share `public/js/agent-tool.js` and the site's `dedupe.js` engine.
- `server.json` is the Official MCP Registry entry `org.removeduplicates/remove-duplicates`. Namespace ownership is proven over HTTP by `/.well-known/mcp-registry-auth` (Ed25519 public key); the private half lives only in the gitignored `local.env.txt`.
- `node scripts/build-agent-files.mjs` regenerates the server card, the skill digest, and `llms-full.txt`; `npm run check` fails when they are stale.

## Commands

    npm run check
    npm test
    npm run verify
    npm run preview
    npm run qa:browser
    npm run benchmark:xlsx
    npm run check:http
    npm run deploy

Runtime preview, the XLSX benchmark, browser QA, downloaded-file readback, and Lighthouse belong on OpenClaw. Port `3630` is reserved for the managed preview. Deployment uses the project-scoped Cloudflare wrapper one directory above; credentials never live in this project.

## Repository hygiene

- Runtime artifacts stay out of Git: `output/`, `.codex-results/`, `.wrangler/`, logs, and `.DS_Store`.
- Secret-bearing files stay out of Git: `.env*`, `local.env.txt`, and `*.env.txt`; only placeholder templates such as `.env.example` may be committed.
- Local planning and provider evidence stay out of Git: `EXCEL_PLAN.md`, `IMPROVEMENT_PLAN.md`, `PROJECT_STATE.md`, `UTILITY_BASELINE.md`, and `ops/`.
- `public/vendor/sheetjs-0.20.3/` is intentionally vendored with its upstream license, source receipt, and SHA-256 checks.

## Cloudflare shape

- Worker: `removeduplicates-org`
- Static assets: `public/`
- Worker entry point: `src/worker.js`
- Static asset binding: `ASSETS`, with `run_worker_first: true`
- Live Workers.dev staging URL: `https://removeduplicates-org.whatmyname.workers.dev/`
- Canonical production domain: `https://removeduplicates.org/`
- Redirecting production alias: `https://www.removeduplicates.org/`

The Worker owns `/excel`, direct legal routes, public HTTP-to-HTTPS and canonical-host redirects, method handling, branded 404s, cache policy, HSTS, a hash-pinned CSP, and Workers.dev `noindex` protection. Excel path case and trailing-slash variants canonicalize to `/excel` in the same one-hop redirect as scheme or host changes. The Worker accepts only GET and HEAD.

## Production release

The active Cloudflare Zone and `wrangler.jsonc` contain exactly these two `custom_domain` routes:

1. `removeduplicates.org`
2. `www.removeduplicates.org`

The Worker returns a 308 from `www` to the apex while preserving path and query. A partial route state is invalid, and no Zone Redirect Rule is used. The production apex, redirect alias, TLS, HTTP matrix, five-viewport browser suite, and Lighthouse are recorded as passing in the project state and production deployment ledger.
