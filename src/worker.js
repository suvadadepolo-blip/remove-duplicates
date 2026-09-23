import { MCP_PATH, handleMcp } from "./mcp.js";

const APEX_HOST = "removeduplicates.org";
const EXCEL_PATH_PATTERN = /^\/excel\/?$/i;
const SHEETJS_VENDOR_PATH = "/vendor/sheetjs-0.20.3/xlsx.mjs";
const HOME_JSON_LD_HASH = [
  "sha256-jjZBhMz8Q4E8hfWG",
  "7E0hEbnLDLVj0sIl/",
  "0UGtkoDBS0="
].join("");
const EXCEL_JSON_LD_HASH = [
  "sha256-PfZLxBN07rDYB332",
  "ZsU2TUVFOuTx4wk/",
  "bTFTvaTkPPU="
].join("");

const ROUTE_ASSETS = new Map([
  ["/", "/index.html"],
  ["/excel", "/excel/index.html"],
  ["/terms", "/terms/index.html"],
  ["/terms/", "/terms/index.html"],
  ["/privacy", "/privacy/index.html"],
  ["/privacy/", "/privacy/index.html"]
]);

// Agent surfaces. Each HTML route has a Markdown twin that is served for
// `Accept: text/markdown` and is also reachable directly for agents that cannot
// set headers.
const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const MARKDOWN_TWINS = new Map([
  ["/", "/index.md"],
  ["/excel", "/excel.md"],
  ["/terms", "/terms.md"],
  ["/terms/", "/terms.md"],
  ["/privacy", "/privacy.md"],
  ["/privacy/", "/privacy.md"]
]);
const MARKDOWN_CANONICALS = new Map([
  ["/index.md", "/"],
  ["/excel.md", "/excel"],
  ["/terms.md", "/terms"],
  ["/privacy.md", "/privacy"]
]);
const AGENT_FILE_TYPES = new Map([
  ["/llms.txt", "text/plain; charset=utf-8"],
  ["/llms-full.txt", "text/plain; charset=utf-8"],
  ["/.well-known/api-catalog", "application/linkset+json"],
  ["/.well-known/ai-catalog.json", "application/json"],
  ["/.well-known/mcp/server-card.json", "application/json"],
  // Official MCP Registry HTTP namespace proof for org.removeduplicates/*.
  ["/.well-known/mcp-registry-auth", "text/plain; charset=utf-8"],
  ["/.well-known/agent-skills/index.json", "application/json"],
  ["/.well-known/agent-skills/remove-duplicates/SKILL.md", MARKDOWN_TYPE],
  ...[...MARKDOWN_CANONICALS.keys()].map((path) => [path, MARKDOWN_TYPE])
]);
// The llmstxt.org filenames are plural; the singular is a common typo.
const AGENT_PATH_ALIASES = new Map([
  ["/llm.txt", "/llms.txt"],
  ["/llm-full.txt", "/llms-full.txt"]
]);
const DISCOVERY_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</llms.txt>; rel="service-doc"; type="text/plain"',
  '</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"'
].join(", ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${HOME_JSON_LD_HASH}' '${EXCEL_JSON_LD_HASH}'`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'none'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join("; ");

function isWorkersDev(hostname) {
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function canonicalTargetFor(url) {
  const target = new URL(url);
  let changed = false;

  if (target.protocol === "http:" && !isLoopback(target.hostname)) {
    target.protocol = "https:";
    changed = true;
  }
  if (target.hostname === `www.${APEX_HOST}`) {
    target.hostname = APEX_HOST;
    changed = true;
  }
  if (EXCEL_PATH_PATTERN.test(target.pathname) && target.pathname !== "/excel") {
    target.pathname = "/excel";
    changed = true;
  }

  return changed ? target : null;
}

function redirectLocationFor(source, target) {
  if (isLoopback(source.hostname) && source.origin === target.origin) {
    return `${target.pathname}${target.search}${target.hash}`;
  }
  return target.toString();
}

// True when the Accept header ranks text/markdown at least as high as HTML.
// Browsers never list text/markdown, so they keep getting HTML.
function prefersMarkdown(accept) {
  if (!accept) return false;
  const quality = new Map();
  for (const part of accept.toLowerCase().split(",")) {
    const [range, ...params] = part.split(";").map((value) => value.trim());
    const q = params.find((param) => param.startsWith("q="));
    const value = q ? Number(q.slice(2)) : 1;
    if (range && Number.isFinite(value)) {
      quality.set(range, Math.max(quality.get(range) ?? 0, value));
    }
  }
  const markdown = quality.get("text/markdown") ?? 0;
  const html = quality.get("text/html") ?? quality.get("text/*") ?? quality.get("*/*") ?? 0;
  return markdown > 0 && markdown >= html;
}

function withHeaders(response, { hostname, pathname, method, protocol, markdown = false }) {
  const headers = new Headers(response.headers);
  // A 304 must repeat the Vary/Link the full response would have carried.
  const served = response.ok || response.status === 304;
  const markdownTwin = served ? MARKDOWN_TWINS.get(pathname) : undefined;
  const agentType = served ? AGENT_FILE_TYPES.get(pathname) : undefined;

  if (markdown) {
    headers.set("Content-Type", MARKDOWN_TYPE);
  } else if (agentType) {
    headers.set("Content-Type", agentType);
  }
  const contentType = headers.get("content-type") || "";

  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Cross-Origin-Resource-Policy",
    agentType || pathname === MCP_PATH ? "cross-origin" : "same-origin"
  );
  headers.set("Origin-Agent-Cluster", "?1");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");

  if (protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  if (markdownTwin) {
    headers.append("Vary", "Accept");
    headers.set(
      "Link",
      `${DISCOVERY_LINKS}, <${markdownTwin}>; rel="alternate"; type="text/markdown"`
    );
  }
  if (agentType) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Robots-Tag", "noindex, follow");
    const canonical = MARKDOWN_CANONICALS.get(pathname);
    if (canonical) {
      headers.set("Link", `<https://${APEX_HOST}${canonical}>; rel="canonical"`);
    }
  }

  if (
    isWorkersDev(hostname) ||
    response.status === 404 ||
    pathname === "/terms" ||
    pathname === "/terms/" ||
    pathname === "/privacy" ||
    pathname === "/privacy/"
  ) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  if (contentType.includes("text/html") || markdown) {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate, no-transform");
  } else if (pathname === SHEETJS_VENDOR_PATH) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (/\.(?:css|js|mjs|webmanifest)$/.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  } else if (/\.(?:svg|png|ico)$/.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  } else if (agentType || pathname === "/robots.txt" || pathname === "/sitemap.xml") {
    headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
  }

  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function responseForMethodNotAllowed(url, method) {
  return withHeaders(
    new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8"
      }
    }),
    { hostname: url.hostname, pathname: url.pathname, method, protocol: url.protocol }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const canonicalTarget = canonicalTargetFor(url);

    if (canonicalTarget) {
      return withHeaders(
        new Response(null, {
          status: 308,
          headers: { Location: redirectLocationFor(url, canonicalTarget) }
        }),
        {
          hostname: url.hostname,
          pathname: url.pathname,
          method: request.method,
          protocol: url.protocol
        }
      );
    }

    const pathname = url.pathname;
    const context = {
      hostname: url.hostname,
      pathname,
      method: request.method,
      protocol: url.protocol
    };

    if (pathname === MCP_PATH) {
      return withHeaders(await handleMcp(request), context);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return responseForMethodNotAllowed(url, request.method);
    }

    const alias = AGENT_PATH_ALIASES.get(pathname);
    if (alias) {
      return withHeaders(
        new Response(null, { status: 308, headers: { Location: `${alias}${url.search}` } }),
        context
      );
    }

    const markdownTwin = MARKDOWN_TWINS.get(pathname);
    const markdown = Boolean(markdownTwin) && prefersMarkdown(request.headers.get("accept"));
    const assetPath = markdown ? markdownTwin : ROUTE_ASSETS.get(pathname);
    const assetRequest = assetPath
      ? new Request(new URL(assetPath, url), request)
      : request;
    let response = await env.ASSETS.fetch(assetRequest);

    if (response.status === 404 && pathname !== "/404.html") {
      const fallback = await env.ASSETS.fetch(
        new Request(new URL("/404.html", url), request)
      );
      response = new Response(request.method === "HEAD" ? null : fallback.body, {
        status: 404,
        statusText: "Not Found",
        headers: fallback.headers
      });
    }

    return withHeaders(response, { ...context, markdown: markdown && response.status !== 404 });
  }
};
